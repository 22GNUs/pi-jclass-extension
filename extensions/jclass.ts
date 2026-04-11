import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = join(EXT_DIR, "..", "bin", "jclass-helper.sh");
const CACHE_DIR = join(homedir(), ".pi", "cache", "jclass");
const INDEX_FILE = join(CACHE_DIR, "index.tsv");
const LAST_OUTPUT_FILE = join(CACHE_DIR, "last-output.txt");

const JCLASS_PARAMS = Type.Object({
  action: StringEnum(["index", "search", "api", "src", "jar"] as const),
  query: Type.Optional(Type.String({
    description: "For search use partial class names like UserProfileDTO. For api/src/jar use fully-qualified class names like com.example.domain.UserProfileDTO.",
  })),
  rebuild: Type.Optional(Type.Boolean({
    description: "Only for action=index. Force rebuild the cached class index.",
    default: false,
  })),
});

type JclassAction = "index" | "search" | "api" | "src" | "jar";

function ensureDirs() {
  mkdirSync(dirname(HELPER_PATH), { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
}

function findJavaProjectRoot(start: string): string | undefined {
  let dir = start;
  while (true) {
    if (
      existsSync(join(dir, "pom.xml")) ||
      existsSync(join(dir, "build.gradle")) ||
      existsSync(join(dir, "build.gradle.kts")) ||
      existsSync(join(dir, "settings.gradle")) ||
      existsSync(join(dir, "settings.gradle.kts"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function usageText() {
  return [
    "Usage:",
    "  /jclass index [--rebuild]",
    "  /jclass search <pattern>",
    "  /jclass api <fully.qualified.ClassName>",
    "  /jclass src <fully.qualified.ClassName>",
    "  /jclass jar <fully.qualified.ClassName>",
    "",
    "Examples:",
    "  /jclass search UserProfileDTO",
    "  /jclass api com.example.domain.UserProfileDTO",
  ].join("\n");
}

async function runHelper(action: JclassAction, query?: string, rebuild?: boolean): Promise<{ code: number; stdout: string; stderr: string }> {
  ensureDirs();

  const args = [HELPER_PATH, action] as string[];
  if (action === "index" && rebuild) args.push("--rebuild");
  if (query) args.push(query);

  return new Promise((resolve) => {
    const child = spawn("bash", args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("error", (err) => {
      resolve({ code: 1, stdout: "", stderr: err.message });
    });
  });
}

function renderResult(action: JclassAction, query: string | undefined, stdout: string, stderr: string) {
  const header = [`Action: ${action}`];
  if (query) header.push(`Query: ${query}`);
  if (stderr) header.push(`Info: ${stderr}`);
  const text = [header.join(" | "), "", stdout || "(no output)"].join("\n");
  writeFileSync(LAST_OUTPUT_FILE, text, "utf8");
  return text;
}

export default function jclassExtension(pi: ExtensionAPI) {
  const javaProjectRoot = findJavaProjectRoot(process.cwd());
  if (!javaProjectRoot) {
    return;
  }

  pi.registerTool({
    name: "jclass_lookup",
    label: "Java Class Lookup",
    description: "Look up external Java classes from Maven dependencies (~/.m2) without manually scanning JARs. Supports search, API inspection, source/decompiled output, and locating the containing JAR.",
    parameters: JCLASS_PARAMS,
    async execute(_toolCallId, params, _signal, onUpdate) {
      const action = params.action as JclassAction;
      const query = params.query?.trim();
      const rebuild = params.rebuild === true;

      if (action !== "index" && !query) {
        return {
          content: [{ type: "text", text: "query is required unless action=index" }],
          details: { ok: false, action },
          isError: true,
        };
      }

      if (!existsSync(INDEX_FILE) && action !== "index") {
        onUpdate?.({
          content: [{ type: "text", text: "jclass cache not found. Building ~/.m2 class index first (one-time cost, usually ~30s)..." }],
          details: { phase: "indexing" },
        });
      } else {
        onUpdate?.({
          content: [{ type: "text", text: `Running jclass ${action}${query ? ` ${query}` : ""}...` }],
          details: { phase: "running", action, query },
        });
      }

      const { code, stdout, stderr } = await runHelper(action, query, rebuild);
      const text = renderResult(action, query, stdout, stderr);

      return {
        content: [{ type: "text", text }],
        details: {
          ok: code === 0,
          action,
          query,
          cacheFile: INDEX_FILE,
          lastOutputFile: LAST_OUTPUT_FILE,
          stderr,
        },
        isError: code !== 0,
      };
    },
  });

  pi.registerCommand("jclass", {
    description: "Inspect external Java dependency classes: /jclass search FooDTO | /jclass api com.example.Foo",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(usageText(), "info");
        return;
      }

      const parts = trimmed.split(/\s+/);
      const action = parts[0] as JclassAction;
      const query = parts.slice(1).join(" ");
      const validActions: JclassAction[] = ["index", "search", "api", "src", "jar"];

      if (!validActions.includes(action)) {
        ctx.ui.notify(`Unknown action: ${action}\n\n${usageText()}`, "warning");
        return;
      }
      if (action !== "index" && !query) {
        ctx.ui.notify(`Missing query for action=${action}\n\n${usageText()}`, "warning");
        return;
      }

      ctx.ui.notify(`Running /jclass ${trimmed} ...`, "info");
      const { code, stdout, stderr } = await runHelper(action, query, trimmed.includes("--rebuild"));
      const text = renderResult(action, query, stdout, stderr);

      const preview = text.split("\n").slice(0, 20).join("\n");
      ctx.ui.notify(code === 0 ? `jclass done. Preview:\n${preview}` : `jclass failed:\n${preview}`, code === 0 ? "info" : "error");
      ctx.ui.notify(`Full output saved to: ${LAST_OUTPUT_FILE}`, "info");
    },
  });
}

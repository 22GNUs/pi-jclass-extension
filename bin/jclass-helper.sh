#!/usr/bin/env bash
# jclass-helper - global cache helper for pi jclass extension
#
# Cache lives at ~/.pi/cache/jclass, independent of any project.
#
# Usage:
#   jclass-helper.sh index [--rebuild]
#   jclass-helper.sh search <pattern>
#   jclass-helper.sh api <fqcn>
#   jclass-helper.sh src <fqcn>
#   jclass-helper.sh jar <fqcn>
#
set -euo pipefail

CACHE_DIR="${JCLASS_CACHE_DIR:-$HOME/.pi/cache/jclass}"
INDEX_FILE="$CACHE_DIR/index.tsv"
M2_REPO="${M2_REPO:-$HOME/.m2/repository}"
MAX_RESULTS="${JCLASS_MAX_RESULTS:-30}"
NPROC=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 8)

if command -v rg &>/dev/null; then
  do_grep() { rg -i --no-filename "$@"; }
  do_fixedgrep() { rg -F --no-filename "$@"; }
else
  do_grep() { LC_ALL=C grep -i "$@"; }
  do_fixedgrep() { LC_ALL=C grep -F "$@"; }
fi

usage() {
  cat <<'EOF'
jclass-helper - Fast Java class lookup for Maven dependencies

Commands:
  index [--rebuild]  Build/rebuild class index from ~/.m2/repository
  search <pattern>   Search classes by name (case-insensitive)
  api <fqcn>         View class API (javap -p)
  src <fqcn>         View source (sources.jar → javap fallback)
  jar <fqcn>         Print the JAR path containing the class
EOF
  exit 1
}

cmd_index() {
  local force=false
  [[ "${1:-}" == "--rebuild" ]] && force=true

  if [[ -f "$INDEX_FILE" && "$force" == false ]]; then
    local count; count=$(wc -l < "$INDEX_FILE" | tr -d ' ')
    echo "Index exists: $count classes"
    return 0
  fi

  mkdir -p "$CACHE_DIR"
  echo "Building class index from $M2_REPO ..." >&2
  echo "  JARs: $(find "$M2_REPO" -name '*.jar' ! -name '*-sources.jar' ! -name '*-javadoc.jar' 2>/dev/null | wc -l | tr -d ' ')" >&2
  echo "  Workers: $NPROC" >&2

  local tmpfile="$INDEX_FILE.tmp.$$"
  trap 'rm -f "${tmpfile:-}"' EXIT

  find "$M2_REPO" -name '*.jar' \
    ! -name '*-sources.jar' \
    ! -name '*-javadoc.jar' \
    -print0 2>/dev/null | \
    xargs -0 -P "$NPROC" -I{} sh -c '
      unzip -Z1 "$1" 2>/dev/null | \
      awk -v jar="$1" '\''/\.class$/ && !/[$]/ {print $0 "\t" jar}'\''
    ' _ {} > "$tmpfile"

  mv "$tmpfile" "$INDEX_FILE"
  trap - EXIT

  local count; count=$(wc -l < "$INDEX_FILE" | tr -d ' ')
  echo "Done: indexed $count classes → $INDEX_FILE" >&2
  echo "$count"
}

ensure_index() {
  if [[ ! -f "$INDEX_FILE" ]]; then
    cmd_index >/dev/null
  fi
}

cmd_search() {
  local pattern="${1:-}"
  [[ -z "$pattern" ]] && { echo "Usage: jclass-helper.sh search <pattern>" >&2; exit 1; }
  ensure_index
  do_grep "$pattern" "$INDEX_FILE" | head -"$MAX_RESULTS" | awk -F'\t' '{
    fqcn = $1
    gsub(/\//, ".", fqcn)
    gsub(/\.class$/, "", fqcn)
    print fqcn "\t" $2
  }'
}

resolve_jar() {
  local fqcn="$1"
  ensure_index
  local class_path; class_path=$(echo "$fqcn" | sed 's/\./\//g').class

  local candidates
  candidates=$(do_fixedgrep "${class_path}	" "$INDEX_FILE" | cut -f2 || true)
  if [[ -z "$candidates" ]]; then
    local simple_name; simple_name=$(echo "$class_path" | sed 's|.*/||')
    candidates=$(do_fixedgrep "${simple_name}	" "$INDEX_FILE" | cut -f2 || true)
  fi
  if [[ -z "$candidates" ]]; then
    return 1
  fi

  local best=""
  local best_mtime=0
  while IFS= read -r jar; do
    [[ -z "$jar" ]] && continue
    local mtime=0
    mtime=$(stat -f%m "$jar" 2>/dev/null || stat -c%Y "$jar" 2>/dev/null || echo 0)
    if [[ "$mtime" -gt "$best_mtime" ]]; then
      best="$jar"
      best_mtime="$mtime"
    fi
  done <<< "$candidates"

  echo "$best"
}

cmd_api() {
  local fqcn="${1:-}"
  [[ -z "$fqcn" ]] && { echo "Usage: jclass-helper.sh api <fqcn>" >&2; exit 1; }
  local jar_path; jar_path=$(resolve_jar "$fqcn") || { echo "Class not found: $fqcn" >&2; exit 1; }
  echo "# JAR: $jar_path"
  javap -p -cp "$jar_path" "$fqcn"
}

cmd_src() {
  local fqcn="${1:-}"
  [[ -z "$fqcn" ]] && { echo "Usage: jclass-helper.sh src <fqcn>" >&2; exit 1; }
  local jar_path; jar_path=$(resolve_jar "$fqcn") || { echo "Class not found: $fqcn" >&2; exit 1; }
  local java_path; java_path=$(echo "$fqcn" | sed 's/\./\//g').java
  local sources_jar; sources_jar=$(echo "$jar_path" | sed 's/\.jar$/-sources.jar/')

  if [[ -f "$sources_jar" ]]; then
    echo "# Source: $sources_jar"
    unzip -p "$sources_jar" "$java_path" 2>/dev/null && exit 0
    echo "# File not found in sources.jar, falling back to javap"
  fi

  echo "# No sources.jar found, using javap"
  echo "# JAR: $jar_path"
  javap -p -cp "$jar_path" "$fqcn"
}

cmd_jar() {
  local fqcn="${1:-}"
  [[ -z "$fqcn" ]] && { echo "Usage: jclass-helper.sh jar <fqcn>" >&2; exit 1; }
  resolve_jar "$fqcn" || { echo "Class not found: $fqcn" >&2; exit 1; }
}

main() {
  case "${1:-}" in
    index) shift; cmd_index "$@" ;;
    search) shift; cmd_search "$@" ;;
    api) shift; cmd_api "$@" ;;
    src) shift; cmd_src "$@" ;;
    jar) shift; cmd_jar "$@" ;;
    *) usage ;;
  esac
}

main "$@"

# pi-jclass-extension

A standalone pi package for fast Java external dependency class lookup.

## What problem it solves

When pi works on Java projects, it cannot click through IDE symbol navigation for classes living inside Maven dependencies.
Manual shell scans like:

```bash
find ~/.m2 -name '*.jar' | while read f; do jar tf "$f" ...; done
```

are slow and block progress.

This package builds a cached class index over `~/.m2/repository` and provides:

- `search` → find matching classes quickly
- `api` → inspect fields + method signatures with `javap`
- `src` → show source from `*-sources.jar`, otherwise decompiled `javap` output
- `jar` → locate the containing JAR

## Performance

Typical numbers on a large local Maven cache:

- first index build: ~30s (one-time)
- search: ~0.2s to ~0.3s
- api/src lookup: ~0.5s

## Activation behavior

The extension only activates inside Java projects, detected by one of:

- `pom.xml`
- `build.gradle`
- `build.gradle.kts`
- `settings.gradle`
- `settings.gradle.kts`

So it will not affect non-Java projects.

## Install

### Temporary trial

```bash
# local path
pi -e /absolute/path/to/pi-jclass-extension

# git source
pi -e git:github.com/22GNUs/pi-jclass-extension
```

### Install globally

```bash
# local path
pi install /absolute/path/to/pi-jclass-extension

# git source
pi install git:github.com/22GNUs/pi-jclass-extension
```

### Install only for one project

```bash
# local path
pi install -l /absolute/path/to/pi-jclass-extension

# git source
pi install -l git:github.com/22GNUs/pi-jclass-extension
```

## What it provides

### Tool

- `jclass_lookup`

Parameters:
- `action`: `index | search | api | src | jar`
- `query`: class name or fully-qualified class name
- `rebuild`: only for `action=index`

### Slash command

- `/jclass`

Examples:

```text
/jclass search UserProfileDTO
/jclass api com.example.domain.UserProfileDTO
/jclass src com.example.domain.ContactPersonDTO
/jclass jar com.example.domain.CompanyInfoDTO
/jclass index --rebuild
```

## Cache location

```text
~/.pi/cache/jclass/index.tsv
```

## Implementation notes

- uses `unzip -Z1` instead of `jar tf` for much faster indexing
- writes an unsorted index to avoid expensive full-index sorting; search does not require sorted rows
- filters class entries in one `awk` pass per JAR to reduce process overhead
- uses `rg` when available for fast searches
- uses `javap -p` for API / decompiled inspection
- prefers `*-sources.jar` when available
- independent package, zero project intrusion

#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_NPM_LOG"
prefix="${npm_config_prefix:-$FAKE_NPM_PREFIX}"
if [ "$1" = "root" ] && [ "$2" = "--global" ]; then
  printf '%s\n' "$prefix/lib/node_modules"
  exit 0
fi
if [ "$1" = "prefix" ] && [ "$2" = "--global" ]; then
  printf '%s\n' "$prefix"
  exit 0
fi
if [ "$1" = "install" ] && [ "$2" = "--global" ]; then
  printf 'registry=%s\n' "${npm_config_registry:-default}" >> "$FAKE_NPM_LOG"
  if [ -n "$FAKE_NPM_DEFAULT_REGISTRY_REFUSES" ] && [ "$npm_config_registry" != "https://registry.npmjs.org/" ]; then
    printf 'npm error code E401\nnpm error Incorrect or missing password.\n' >&2
    exit 1
  fi
  package_root="$prefix/lib/node_modules/${FAKE_NPM_PACKAGE:-@example/acp}"
  executable="$prefix/bin/${FAKE_NPM_EXECUTABLE_NAME:-example-agent}"
  mkdir -p "$package_root" "$prefix/bin"
  printf '%s' "$FAKE_NPM_MANIFEST" > "$package_root/package.json"
  printf '#!/bin/sh\n' > "$executable"
  chmod 755 "$executable"
  if [ -n "$FAKE_NPM_INSTALL_ENV_LOG" ]; then
    printf '%s\n%s\n%s\n' "$HOME" "$GROK_HOME" "$GROK_INSTALL_COMPLETIONS" > "$FAKE_NPM_INSTALL_ENV_LOG"
    mkdir -p "$GROK_HOME/bin"
    printf '#!/bin/sh\n' > "$GROK_HOME/bin/grok"
    chmod 755 "$GROK_HOME/bin/grok"
  fi
  exit 0
fi
exit 64

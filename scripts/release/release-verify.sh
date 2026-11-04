# Sourced by release.sh: the verify stage, after sign and before helpers, plan and drafts, on
# this Mac and on the CI Mac (--ci) alike. The signed zip, unpacked as a person gets it, runs
# headless in throwaway homes (scripts/release/verify-built-app.mjs --mode all):
#   fresh     the bundled server reports $VERSION, a thread and the coordinator answer through
#             the offline fake ACP agent within 120 s, then the startup acceptance proof
#             (scripts/studio-fleet/test-startup.mjs);
#   upgraded  a home from the previous release's state passes the post-update check
#             (update.py verify --local) and test-installed-startup.mjs --local.
# The previous release's state is the fixture its own verify stage left in its staging folder
# (verify/state-fixture.tar.gz), else one made now by the fresh run on its published zip, checked
# against its SHA256SUMS and GitHub's digests. This stage leaves this release's fixture for the
# next one. A verify that did not pass, or did not run, stops the release: drafts refuses a
# candidate without a verify marker. Uses release.sh's x, q, die, say, remove_owned, ensure_dir,
# is_done and its globals (MODE, STAGE, STAGING_ROOT, ASSETS, BUILD, VERSION, PREV, SHA, SHA12,
# PRIVATE_REPO, TOOLS, NO_GH_TOKEN).

stage_verify() {
  local out="$STAGE/app-verify-$SHA12" kept="$STAGING_ROOT/$PREV/verify/state-fixture.tar.gz"
  local zip="SpecWithCode-$PREV-arm64.zip" previous=() result
  remove_owned "$out"
  ensure_dir "$out" "$STAGE/verify"
  if [ -f "$kept" ]; then
    previous=(--fixture "$kept")
  else
    say "verify: no state fixture from $PREV in $STAGING_ROOT; making one from its published app"
    x verify-prev-app -- gh release download "v$PREV" -R "$PRIVATE_REPO" -p "$zip" -D "$STAGE/prev" --clobber
    x verify-prev-app-sums -- python3 -B "$TOOLS" verify-sums --dir "$STAGE/prev" --digests "$STAGE/prev/assets.json" "$zip"
    previous=(--previous-archive "$STAGE/prev/$zip")
  fi
  x verify-app -C "$BUILD" -- "${NO_GH_TOKEN[@]}" PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never \
    node scripts/release/verify-built-app.mjs --mode all --archive "$ASSETS/SpecWithCode-$VERSION-arm64.zip" \
    --version "$VERSION" --out "$out" "${previous[@]}" --fixture-out "$STAGE/verify/state-fixture.tar.gz"
  # The receipt, not only the exit status: both modes must say passed.
  result="$(q verify-result --may-fail -- python3 -B "$TOOLS" json-get "$out/receipt.json" result)"
  [ "$result" = passed ] ||
    die "verify: the built app's receipt says ${result:-nothing} ($out/receipt.json); a skipped or failed verify stops the release"
}

# Before drafts: nothing is drafted or published from a candidate whose verify stage did not pass.
require_verified() {
  [ "$MODE" = dry ] && return 0
  is_done verify "$SHA" ||
    die "drafts: candidate $SHA12 has no passed verify stage; run it with --resume (a skipped verify is a failure)"
}

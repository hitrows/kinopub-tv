#!/bin/sh
# Ship the current main to every installed cloud build ("Kinopub" on the TV).
# The Worker serves the TV app from the git tag "cloud"; installed apps pick
# the new version up on their next launch.
#
#   ./release-cloud.sh        -> bump VERSION (1.2 -> 1.3), commit, move the tag
#   ./release-cloud.sh 2.0    -> exactly 2.0
set -e
cd "$(dirname "$0")"
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first"; exit 1; }
LAST=$(cat VERSION)
V=${1:-$(echo "$LAST" | awk -F. '{ printf "%d.%d", $1, $2 + 1 }')}
echo "$V" > VERSION
git commit -q -m "Release $V" VERSION
git push -q origin HEAD
git tag -f cloud
git push -q -f origin cloud
echo "released $V: TVs get it on next launch (GitHub's raw cache may take a few minutes)"

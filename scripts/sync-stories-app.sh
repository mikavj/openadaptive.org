#!/bin/sh
# Refreshes the hosted copy of the stories web app from the app repository.
# The canonical source lives in open-adaptive-stories/docs/app; this site
# serves a copy at /stories/app/. Run this after the web app changes, then
# commit and push the site.
set -eu

site_dir="$(cd "$(dirname "$0")/.." && pwd)"
src_dir="$site_dir/../open-adaptive-stories/docs/app"

if [ ! -f "$src_dir/index.html" ] || [ ! -f "$src_dir/app.js" ]; then
  echo "error: web app not found at $src_dir" >&2
  echo "expected open-adaptive-stories to be checked out next to this repo" >&2
  exit 1
fi

cp "$src_dir/index.html" "$src_dir/app.js" "$site_dir/stories/app/"
echo "synced stories web app from $src_dir"

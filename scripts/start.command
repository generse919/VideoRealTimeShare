#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found."
  echo "Please install it from https://nodejs.org/ (LTS version),"
  echo "then double-click this file again."
  echo
  read -p "Press Enter to close..." _
  exit 1
fi

node server/launcher.mjs

echo
read -p "Press Enter to close..." _

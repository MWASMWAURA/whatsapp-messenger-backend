#!/usr/bin/env bash
# exit on error
set -o errexit

# Only install npm dependencies
npm install

# Install Puppeteer's bundled Chromium
npx puppeteer browsers install chrome

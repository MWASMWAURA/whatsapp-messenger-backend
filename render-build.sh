#!/usr/bin/env bash
# exit on error
set -o errexit

# Install npm dependencies
npm install

# Install Chromium for Puppeteer
npx puppeteer browsers install chrome
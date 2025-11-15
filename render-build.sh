#!/usr/bin/env bash
# exit on error
set -o errexit

echo "📦 Installing npm dependencies..."
npm install

echo "🔍 Verifying Chrome installation..."
if [ -d ".cache/puppeteer/chrome" ]; then
  echo "✅ Chrome found in .cache/puppeteer/chrome"
  ls -la .cache/puppeteer/chrome/
else
  echo "❌ Chrome not found in expected location!"
  echo "📁 Checking all possible locations..."
  find . -name "chrome" -type f 2>/dev/null || echo "No chrome binary found"
fi

echo "✅ Build complete!"
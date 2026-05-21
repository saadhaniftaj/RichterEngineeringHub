#!/usr/bin/env bash
# build.sh — Packages Lambda handler + dependencies into a zip
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
ZIP_FILE="$SCRIPT_DIR/lambda_package.zip"

echo "🧹 Cleaning build directory..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

echo "📦 Installing dependencies..."
pip3 install \
  --platform manylinux2014_x86_64 \
  --implementation cp \
  --python-version 3.11 \
  --only-binary=:all: \
  --upgrade \
  -r "$SCRIPT_DIR/requirements.txt" \
  -t "$BUILD_DIR"

echo "📋 Copying handler..."
cp "$SCRIPT_DIR/handler.py" "$BUILD_DIR/"

echo "🗜️  Creating zip..."
cd "$BUILD_DIR"
zip -r "$ZIP_FILE" . -x "*.pyc" -x "__pycache__/*"

echo "✅ Build complete: $ZIP_FILE ($(du -sh "$ZIP_FILE" | cut -f1))"

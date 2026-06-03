#!/bin/bash
set -e

echo "============================================"
echo "  MelodyBox 无损音乐播放器 - APK 构建工具"
echo "============================================"
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
    echo "[错误] 未找到 Node.js，请先安装: https://nodejs.org"
    exit 1
fi
echo "[✓] Node.js: $(node --version)"

# Check Java
if ! command -v java &>/dev/null; then
    echo "[错误] 未找到 Java JDK，请安装 JDK 17+"
    exit 1
fi
echo "[✓] Java: $(java --version 2>&1 | head -1)"

# Find Android SDK
if [ -z "$ANDROID_HOME" ] && [ -z "$ANDROID_SDK_ROOT" ]; then
    if [ -d "$HOME/Android/Sdk" ]; then
        export ANDROID_HOME="$HOME/Android/Sdk"
        echo "[✓] 找到 Android SDK: $ANDROID_HOME"
    elif [ -d "$HOME/Library/Android/sdk" ]; then
        export ANDROID_HOME="$HOME/Library/Android/sdk"
        echo "[✓] 找到 Android SDK: $ANDROID_HOME"
    else
        echo "[错误] 未找到 Android SDK，请设置 ANDROID_HOME 环境变量"
        exit 1
    fi
else
    export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
    echo "[✓] Android SDK: $ANDROID_HOME"
fi

# Install dependencies
echo ""
echo "[1/4] 安装依赖..."
npm install

# Initialize Android project (first time only)
if [ ! -d "android" ]; then
    echo ""
    echo "[2/4] 初始化 Android 项目..."
    npx cap add android
else
    echo ""
    echo "[2/4] Android 项目已存在，跳过初始化"
fi

# Sync web assets
echo ""
echo "[3/4] 同步 Web 资源..."
npx cap sync android

# Build APK
echo ""
echo "[4/4] 编译 APK..."
cd android
chmod +x gradlew 2>/dev/null || true
./gradlew assembleDebug
cd ..

# Done
APK_PATH="android/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK_PATH" ]; then
    echo ""
    echo "============================================"
    echo "  ✓ 构建成功！"
    echo "  APK: $APK_PATH"
    echo ""
    echo "  将 APK 传输到手机安装即可"
    echo "  adb install $APK_PATH"
    echo "============================================"
else
    echo "[警告] APK 文件未找到，请检查编译输出"
    exit 1
fi

@echo off
chcp 65001 >nul
title MelodyBox APK Builder
echo ============================================
echo   MelodyBox 无损音乐播放器 - APK 构建工具
echo ============================================
echo.

:: Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [错误] 未找到 Node.js，请先安装: https://nodejs.org
    pause
    exit /b 1
)
echo [✓] Node.js: %node_version%

:: Check Java
where java >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [错误] 未找到 Java JDK，请安装 JDK 17+
    pause
    exit /b 1
)
echo [✓] Java 已就绪

:: Check Android SDK
if "%ANDROID_HOME%"=="" (
    if "%ANDROID_SDK_ROOT%"=="" (
        echo [警告] 未设置 ANDROID_HOME，尝试查找 Android SDK...
        if exist "%LOCALAPPDATA%\Android\Sdk" (
            set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
            echo [✓] 找到 Android SDK: %ANDROID_HOME%
        ) else (
            echo [错误] 未找到 Android SDK
            echo 请安装 Android Studio 或设置 ANDROID_HOME 环境变量
            pause
            exit /b 1
        )
    )
)
echo [✓] Android SDK: %ANDROID_HOME%

:: Install dependencies
echo.
echo [1/4] 安装依赖...
call npm install
if %ERRORLEVEL% neq 0 (
    echo [错误] npm install 失败
    pause
    exit /b 1
)

:: Initialize Android project (first time only)
if not exist "android\" (
    echo.
    echo [2/4] 初始化 Android 项目...
    call npx cap add android
    if %ERRORLEVEL% neq 0 (
        echo [错误] Android 项目初始化失败
        pause
        exit /b 1
    )
) else (
    echo.
    echo [2/4] Android 项目已存在，跳过初始化
)

:: Sync web assets
echo.
echo [3/4] 同步 Web 资源...
call npx cap sync android
if %ERRORLEVEL% neq 0 (
    echo [错误] 同步失败
    pause
    exit /b 1
)

:: Build APK
echo.
echo [4/4] 编译 APK...
cd android
call gradlew assembleDebug
if %ERRORLEVEL% neq 0 (
    cd ..
    echo [错误] APK 编译失败，请检查错误信息
    pause
    exit /b 1
)
cd ..

:: Done
set APK_PATH=android\app\build\outputs\apk\debug\app-debug.apk
if exist "%APK_PATH%" (
    echo.
    echo ============================================
    echo   ✓ 构建成功！
    echo   APK 位置: %APK_PATH%
    echo.
    echo   将 APK 传输到手机安装即可
    echo ============================================
    explorer /select,"%APK_PATH%"
) else (
    echo [警告] APK 文件未找到，请检查编译输出
)

pause

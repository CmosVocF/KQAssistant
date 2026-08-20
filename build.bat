@echo off
chcp 65001 >nul
rem ============================================================
rem  一键打包脚本 (Windows)
rem  - 使用本地 JDK 17（优先 env\jdk，其次 apkre 的工具 JDK，最后系统 JAVA_HOME）
rem  - Android SDK 路径来自 local.properties (sdk.dir=env/android-sdk)
rem  - 用法: build.bat            -> assembleDebug
rem         build.bat release    -> assembleRelease
rem         build.bat clean debug -> 先 clean 再 assembleDebug
rem ============================================================
setlocal

rem ---- 走系统代理(127.0.0.1:7897)下载国外依赖; 本机 IPv6 不可用, 强制 IPv4 ----
if not defined JAVA_TOOL_OPTIONS set "JAVA_TOOL_OPTIONS=-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=7897 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=7897 -Djava.net.preferIPv4Stack=true"
if not defined HTTP_PROXY   set "HTTP_PROXY=http://127.0.0.1:7897"
if not defined HTTPS_PROXY  set "HTTPS_PROXY=http://127.0.0.1:7897"

rem ---- Gradle 发行版 + 依赖缓存也放项目内，环境完全自包含 ----
set "GRADLE_USER_HOME=%CD%\env\gradle-home"

rem ---- 选定 JDK ----
if exist "%CD%\env\jdk\bin\java.exe" (
    set "JAVA_HOME=%CD%\env\jdk"
) else if exist "D:\apkre\tools\jdk\jdk-17.0.20+8" (
    set "JAVA_HOME=D:\apkre\tools\jdk\jdk-17.0.20+8"
) else if defined JAVA_HOME (
    rem 使用系统已配置的 JAVA_HOME
) else (
    echo [ERROR] 未找到 JDK 17，请安装并设置 JAVA_HOME。
    pause & exit /b 1
)
set "PATH=%JAVA_HOME%\bin;%PATH%"

rem ---- 生成 local.properties（若缺失） ----
if not exist "%CD%\local.properties" (
    echo sdk.dir=%CD:\=/%/env/android-sdk> "%CD%\local.properties"
    echo [INFO] 已生成 local.properties: sdk.dir=%CD:\=/%/env/android-sdk
)

echo [JAVA_HOME] %JAVA_HOME%
"%JAVA_HOME%\bin\java.exe" -version 2>&1 | findstr /i "version" >nul
echo ============================================================
echo   开始构建 ...  args: %*
echo ============================================================

set "TASK=assembleDebug"
if /I "%~1"=="release"  set "TASK=assembleRelease"
if /I "%~1"=="clean"    call gradlew.bat clean
if /I "%~1"=="clean"    set "TASK=assembleDebug"

call gradlew.bat %TASK%
echo.
if %errorlevel%==0 (
    echo [OK] 构建完成。APK 位于 app\build\outputs\apk\debug\ 或 ...\release\
) else (
    echo [FAIL] 构建失败，请查看上方日志。
)
endlocal

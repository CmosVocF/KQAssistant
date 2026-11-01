plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.hrpunch"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.hrpunch"
        minSdk = 24
        targetSdk = 34
        versionCode = 36
        versionName = "1.4.0-test026"

        // 只打包 arm64，控制 OpenCV 原生库体积
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    signingConfigs {
        getByName("debug") {
            // 使用默认 debug keystore；release 复用它，方便直接安装测试
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // 每个版本的 APK 文件名带版本号，避免不同测试版互相覆盖
    applicationVariants.all {
        val vn = versionName ?: ""
        val vName = name
        outputs.all {
            (this as com.android.build.gradle.internal.api.BaseVariantOutputImpl).outputFileName =
                "KQAssistant-$vn-$vName.apk"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.webkit:webkit:1.10.0")
    // 文档/表格边缘自动检测（CLAHE + Canny + 轮廓 + 四边形拟合）
    implementation("org.opencv:opencv:4.9.0")
}

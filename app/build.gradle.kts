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
        versionCode = 25
        versionName = "1.4.0-test015"
    }

    signingConfigs {
        getByName("debug") {
            // 浣跨敤榛樿 debug keystore锛況elease 澶嶇敤瀹冿紝鏂逛究鐩存帴瀹夎娴嬭瘯
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

    // 姣忎釜鐗堟湰鐨?APK 鏂囦欢鍚嶅甫鐗堟湰鍙凤紝閬垮厤涓嶅悓娴嬭瘯鐗堜簰鐩歌鐩?
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
}

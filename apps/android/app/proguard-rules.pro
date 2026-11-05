# R8 rules for the release build.
#
# kotlinx.serialization and OkHttp ship consumer rules in their jars; the rules below are the
# documented app-side additions and keep every @Serializable model in our own packages, including
# the :wire protocol types, the navigation routes and the Connect (Clerk frontend API) responses.

-keepattributes *Annotation*, InnerClasses, Signature, EnclosingMethod, RuntimeVisibleAnnotations, AnnotationDefault
-dontnote kotlinx.serialization.**

# Serializer lookups for our own @Serializable classes (companion serializer() and generated $serializer).
-if @kotlinx.serialization.Serializable class com.specwithcode.**
-keepclassmembers class <1> {
    static <1>$Companion Companion;
}
-if @kotlinx.serialization.Serializable class com.specwithcode.** {
    static **$* *;
}
-keepclassmembers class <2>$<3> {
    kotlinx.serialization.KSerializer serializer(...);
}
-if @kotlinx.serialization.Serializable class com.specwithcode.** {
    public static ** INSTANCE;
}
-keepclassmembers class <1> {
    public static <1> INSTANCE;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclassmembers class com.specwithcode.** {
    *** Companion;
}
-keepclasseswithmembers class com.specwithcode.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.specwithcode.**$$serializer { *; }

# Serial names come from @SerialName, so obfuscated field names are fine; keep enum entries readable
# for open enums that fall back to their raw value.
-keepclassmembers enum com.specwithcode.** {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# OkHttp optional platform integrations that are not on Android.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# Error Prone and other compile-only annotations referenced by Google libraries.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**

# ML Kit finds its components by reflection on no-arg registrar constructors; without these the QR
# scanner cannot start in release builds.
-keep class * implements com.google.firebase.components.ComponentRegistrar { <init>(); }
-keep class com.google.mlkit.**.*Registrar { <init>(); }

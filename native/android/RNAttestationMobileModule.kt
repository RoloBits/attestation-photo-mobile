package com.attestation.mobile

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import java.io.File
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Date
import javax.security.auth.x500.X500Principal

class RNAttestationMobileModule(context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {

  private val keyAlias = "com.attestation.mobile.signingkey"

  override fun getName(): String = "RNAttestationMobile"

  private fun isPhysicalDevice(): Boolean {
    return !(Build.FINGERPRINT.contains("generic", ignoreCase = true) ||
      Build.MODEL.contains("Emulator", ignoreCase = true) ||
      Build.HARDWARE.contains("goldfish", ignoreCase = true))
  }

  private fun isCompromisedDevice(): Boolean {
    return Build.TAGS?.contains("test-keys") == true
  }

  private fun readTrustLevelFromPrivateKey(privateKey: PrivateKey): String {
    return try {
      val keyFactory = KeyFactory.getInstance(privateKey.algorithm, "AndroidKeyStore")
      val keyInfo = keyFactory.getKeySpec(privateKey, KeyInfo::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && keyInfo.isStrongBoxBacked) {
        "strongbox"
      } else if (keyInfo.isInsideSecureHardware) {
        "tee"
      } else {
        "software_fallback"
      }
    } catch (_: Throwable) {
      "software_fallback"
    }
  }

  private fun getExistingPrivateKey(): PrivateKey? {
    val keyStore = KeyStore.getInstance("AndroidKeyStore")
    keyStore.load(null)
    val key = keyStore.getKey(keyAlias, null)
    return key as? PrivateKey
  }

  private fun createSigningKey(preferStrongBox: Boolean): PrivateKey {
    val keyPairGenerator = KeyPairGenerator.getInstance(
      KeyProperties.KEY_ALGORITHM_EC,
      "AndroidKeyStore"
    )
    val builder = KeyGenParameterSpec.Builder(
      keyAlias,
      KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
    )
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setUserAuthenticationRequired(false)
      .setCertificateSubject(X500Principal("CN=AtomicC2PA Self-Signed"))
      .setCertificateSerialNumber(BigInteger.valueOf(System.currentTimeMillis()))
      .setCertificateNotBefore(Date())
      .setCertificateNotAfter(Date(System.currentTimeMillis() + 365L * 24 * 60 * 60 * 1000))

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      builder.setIsStrongBoxBacked(preferStrongBox)
    }

    keyPairGenerator.initialize(builder.build())
    return keyPairGenerator.generateKeyPair().private
  }

  private fun getOrCreateSigningKey(): Pair<PrivateKey, String> {
    val existing = getExistingPrivateKey()
    if (existing != null) {
      return existing to readTrustLevelFromPrivateKey(existing)
    }

    return try {
      val key = createSigningKey(preferStrongBox = true)
      key to readTrustLevelFromPrivateKey(key)
    } catch (_: StrongBoxUnavailableException) {
      val fallback = createSigningKey(preferStrongBox = false)
      fallback to readTrustLevelFromPrivateKey(fallback)
    } catch (_: Throwable) {
      val fallback = createSigningKey(preferStrongBox = false)
      fallback to readTrustLevelFromPrivateKey(fallback)
    }
  }

  private fun sha256Hex(bytes: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
    val out = StringBuilder(digest.size * 2)
    for (b in digest) {
      out.append(String.format("%02x", b))
    }
    return out.toString()
  }

  private fun loadSourcePhoto(params: ReadableMap): Pair<String, ByteArray> {
    if (!params.hasKey("sourcePhotoPath")) {
      throw IllegalArgumentException("sourcePhotoPath is required")
    }
    val sourcePath = params.getString("sourcePhotoPath")
    if (sourcePath.isNullOrBlank()) {
      throw IllegalArgumentException("sourcePhotoPath is required")
    }
    val source = File(sourcePath)
    if (!source.exists() || source.length() <= 0) {
      throw IllegalStateException("source image is missing or empty")
    }
    return source.absolutePath to source.readBytes()
  }

  // ---------------------------------------------------------------------------
  // AndroidHardwareSigner: implements the UniFFI HardwareSigner interface
  // ---------------------------------------------------------------------------

  class AndroidHardwareSigner(
    private val privateKey: PrivateKey,
    private val keyAlias: String
  ) : HardwareSigner {

    override fun sign(data: ByteArray): ByteArray {
      val sig = Signature.getInstance("SHA256withECDSA")
      sig.initSign(privateKey)
      sig.update(data)
      return sig.sign()
    }

    override fun certificateDer(): ByteArray {
      // Android KeyStore auto-generates a self-signed cert at key creation
      val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      return ks.getCertificate(keyAlias)?.encoded
        ?: throw IllegalStateException("No certificate found for key alias: $keyAlias")
    }
  }

  // ---------------------------------------------------------------------------
  // React Native methods
  // ---------------------------------------------------------------------------

  @ReactMethod
  fun getAttestationStatus(promise: Promise) {
    try {
      val (_, trustLevel) = getOrCreateSigningKey()
      val result = Arguments.createMap()
      result.putBoolean("isPhysicalDevice", isPhysicalDevice())
      result.putBoolean("isCompromised", isCompromisedDevice())
      result.putString("trustLevel", trustLevel)
      promise.resolve(result)
    } catch (t: Throwable) {
      promise.reject("E_ATTESTATION_FAILED", "Failed to check hardware attestation status", t)
    }
  }

  @ReactMethod
  fun ensureHardwareKey(promise: Promise) {
    try {
      val (_, trustLevel) = getOrCreateSigningKey()
      val result = Arguments.createMap()
      result.putString("trustLevel", trustLevel)
      promise.resolve(result)
    } catch (t: Throwable) {
      promise.reject("E_ATTESTATION_FAILED", "Failed to provision signing key", t)
    }
  }

  @ReactMethod
  fun signPayload(params: ReadableMap, promise: Promise) {
    if (!params.hasKey("payloadBase64")) {
      promise.reject("E_SIGNING_FAILED", "payloadBase64 is required")
      return
    }
    val payloadBase64 = params.getString("payloadBase64")
    val payload = try {
      Base64.decode(payloadBase64, Base64.DEFAULT)
    } catch (t: Throwable) {
      promise.reject("E_SIGNING_FAILED", "Invalid payloadBase64", t)
      return
    }

    try {
      val (privateKey, trustLevel) = getOrCreateSigningKey()
      val signature = Signature.getInstance("SHA256withECDSA")
      signature.initSign(privateKey)
      signature.update(payload)
      val signed = signature.sign()

      val result = Arguments.createMap()
      result.putString("signatureBase64", Base64.encodeToString(signed, Base64.NO_WRAP))
      result.putString("trustLevel", trustLevel)
      promise.resolve(result)
    } catch (t: Throwable) {
      promise.reject("E_SIGNING_FAILED", "Hardware signing failed", t)
    }
  }

  @ReactMethod
  fun hashPhotoAtPath(params: ReadableMap, promise: Promise) {
    if (!params.hasKey("sourcePhotoPath")) {
      promise.reject("E_CAPTURE_FAILED", "sourcePhotoPath is required")
      return
    }
    val sourcePath = params.getString("sourcePhotoPath")
    if (sourcePath.isNullOrBlank()) {
      promise.reject("E_CAPTURE_FAILED", "sourcePhotoPath is required")
      return
    }
    try {
      val source = File(sourcePath)
      if (!source.exists() || source.length() <= 0) {
        promise.reject("E_CAPTURE_FAILED", "source image is missing or empty")
        return
      }
      val result = Arguments.createMap()
      result.putString("sha256Hex", sha256Hex(source.readBytes()))
      promise.resolve(result)
    } catch (t: Throwable) {
      promise.reject("E_CAPTURE_FAILED", "Failed to hash source image", t)
    }
  }

  @ReactMethod
  fun captureAndSignAtomic(params: ReadableMap, promise: Promise) {
    Thread {
      val nonce = if (params.hasKey("nonce")) params.getString("nonce") else null
      val now = java.time.Instant.now().toString()

      try {
        val (sourcePath, captureBytes) = loadSourcePhoto(params)
        val (privateKey, trustLevel) = getOrCreateSigningKey()
        val signer = AndroidHardwareSigner(privateKey, keyAlias)

        var latitude: Double? = null
        var longitude: Double? = null
        if (params.hasKey("includeLocation") && params.getBoolean("includeLocation")) {
          if (params.hasKey("latitude")) latitude = params.getDouble("latitude")
          if (params.hasKey("longitude")) longitude = params.getDouble("longitude")
        }

        val context = CaptureContext(
          deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}",
          osVersion = "Android ${Build.VERSION.RELEASE}",
          capturedAtIso8601 = now,
          trustLevel = trustLevel,
          nonce = nonce,
          latitude = latitude,
          longitude = longitude
        )

        // Single Rust call: hash -> build manifest -> sign (callback) -> embed JUMBF
        val c2paResult = buildAndSignC2pa(
          jpegBytes = captureBytes,
          context = context,
          signer = signer
        )

        // Atomic write of signed JPEG (replaces unsigned original)
        val destFile = File(sourcePath)
        val tempFile = File(destFile.parent, ".${destFile.name}.tmp")
        try {
          tempFile.writeBytes(c2paResult.signedJpeg)
          if (!tempFile.renameTo(destFile)) {
            tempFile.delete()
            throw java.io.IOException("Atomic rename failed for ${destFile.absolutePath}")
          }
        } catch (e: Throwable) {
          tempFile.delete()
          throw e
        }

        val metadata = Arguments.createMap()
        metadata.putString("deviceModel", "${Build.MANUFACTURER} ${Build.MODEL}")
        metadata.putString("osVersion", "Android ${Build.VERSION.RELEASE}")
        metadata.putString("capturedAtIso8601", now)
        metadata.putString("sourceSha256", c2paResult.assetHashHex)
        metadata.putString("pipelineMode", "c2pa-atomic")
        if (nonce != null) {
          metadata.putString("nonce", nonce)
        }

        val result = Arguments.createMap()
        result.putString("path", sourcePath)
        result.putString("signature", c2paResult.assetHashHex)
        result.putString("algorithm", "ECDSA_P256_SHA256")
        result.putString("manifestFormat", "c2pa-jumbf")
        result.putString("trustLevel", trustLevel)
        result.putBoolean("embeddedManifest", true)
        result.putMap("metadata", metadata)
        promise.resolve(result)
      } catch (t: Throwable) {
        promise.reject("E_CAPTURE_FAILED", "captureAndSignAtomic failed: ${t.message}", t)
      }
    }.start()
  }
}

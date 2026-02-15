package com.attestation.mobile

import android.Manifest
import android.content.ContentValues
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import android.util.Log
import java.io.File
import java.math.BigInteger
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import android.location.LocationListener
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Date
import javax.security.auth.x500.X500Principal
import uniffi.attestation_mobile.CaptureContext
import uniffi.attestation_mobile.HardwareSigner
import uniffi.attestation_mobile.buildAndSignC2pa

class RNAttestationMobileModule(context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {

  companion object {
    private const val TAG = "RNAttestationMobile"
  }

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
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        when (keyInfo.securityLevel) {
          KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
          KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
          else -> "software_fallback"
        }
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
      .setCertificateSubject(X500Principal("O=Attestation Mobile, CN=Attestation Mobile Self-Signed"))
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

    // Retry loop for camera file write race condition
    var retries = 0
    val maxRetries = 5
    val retryDelayMs = 100L
    while (retries < maxRetries) {
      if (source.exists() && source.length() > 100) break
      Log.d(TAG, "loadSourcePhoto: waiting for file (attempt ${retries + 1}/$maxRetries), exists=${source.exists()}, size=${if (source.exists()) source.length() else -1}")
      Thread.sleep(retryDelayMs)
      retries++
    }

    if (!source.exists() || source.length() <= 0) {
      Log.e(TAG, "loadSourcePhoto: file missing or empty after $maxRetries retries: $sourcePath")
      throw IllegalStateException("source image is missing or empty: $sourcePath")
    }

    val bytes = source.readBytes()
    Log.d(TAG, "loadSourcePhoto: read ${bytes.size} bytes from $sourcePath")
    if (bytes.size >= 4) {
      Log.d(TAG, "loadSourcePhoto: first 4 bytes = ${bytes.take(4).joinToString(" ") { String.format("%02X", it) }}")
    }
    return source.absolutePath to bytes
  }

  @Suppress("MissingPermission")
  private fun fetchLocationWithTimeout(): Location? {
    val context = reactApplicationContext
    val hasFine = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    val hasCoarse = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    if (!hasFine && !hasCoarse) {
      Log.d(TAG, "fetchLocationWithTimeout: no location permission, skipping GPS")
      return null
    }

    val locationManager = context.getSystemService(android.content.Context.LOCATION_SERVICE) as? LocationManager ?: return null

    // Try active single-update request (GPS first, then network)
    val providers = mutableListOf<String>()
    if (hasFine && locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
      providers.add(LocationManager.GPS_PROVIDER)
    }
    if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
      providers.add(LocationManager.NETWORK_PROVIDER)
    }

    val latch = CountDownLatch(1)
    var result: Location? = null
    val resultLock = Any()

    val listener = LocationListener { location ->
      synchronized(resultLock) {
        if (result == null) {
          result = location
        }
      }
      latch.countDown()
    }

    val looper = android.os.Looper.getMainLooper()

    for (provider in providers) {
      try {
        Log.d(TAG, "fetchLocationWithTimeout: requesting single update from $provider")
        locationManager.requestSingleUpdate(provider, listener, looper)
      } catch (t: Throwable) {
        Log.d(TAG, "fetchLocationWithTimeout: $provider unavailable: ${t.message}")
      }
    }

    // Wait up to 5 seconds for a fix (matches iOS timeout)
    val gotFix = latch.await(5, TimeUnit.SECONDS)

    // Remove listener regardless of outcome
    try {
      locationManager.removeUpdates(listener)
    } catch (_: Throwable) {}

    if (gotFix && result != null) {
      Log.d(TAG, "fetchLocationWithTimeout: active fix lat=${result!!.latitude}, lon=${result!!.longitude}, provider=${result!!.provider}")
      return result
    }

    // Fallback: check cached last-known location
    Log.d(TAG, "fetchLocationWithTimeout: active request timed out, trying getLastKnownLocation")
    val fallbackProviders = mutableListOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      fallbackProviders.add(LocationManager.FUSED_PROVIDER)
    }

    var best: Location? = null
    for (provider in fallbackProviders) {
      try {
        val loc = locationManager.getLastKnownLocation(provider)
        if (loc != null && (best == null || loc.time > best.time)) {
          best = loc
        }
      } catch (_: Throwable) {}
    }

    if (best != null) {
      Log.d(TAG, "fetchLocationWithTimeout: fallback lat=${best.latitude}, lon=${best.longitude}, provider=${best.provider}")
    } else {
      Log.d(TAG, "fetchLocationWithTimeout: no location available")
    }
    return best
  }

  // ---------------------------------------------------------------------------
  // ASN.1 DER encoding helpers
  // ---------------------------------------------------------------------------

  private fun asn1Length(length: Int): ByteArray {
    return when {
      length < 128 -> byteArrayOf(length.toByte())
      length < 256 -> byteArrayOf(0x81.toByte(), length.toByte())
      else -> byteArrayOf(0x82.toByte(), (length shr 8).toByte(), (length and 0xFF).toByte())
    }
  }

  private fun asn1Sequence(content: ByteArray): ByteArray {
    return byteArrayOf(0x30) + asn1Length(content.size) + content
  }

  private fun asn1Set(content: ByteArray): ByteArray {
    return byteArrayOf(0x31) + asn1Length(content.size) + content
  }

  private fun asn1Integer(data: ByteArray): ByteArray {
    var bytes = data
    // Prepend 0x00 if high bit is set (to keep positive)
    if (bytes.isNotEmpty() && (bytes[0].toInt() and 0x80) != 0) {
      bytes = byteArrayOf(0x00) + bytes
    }
    return byteArrayOf(0x02) + asn1Length(bytes.size) + bytes
  }

  private fun asn1BitString(data: ByteArray): ByteArray {
    val content = byteArrayOf(0x00) + data // 0 unused bits
    return byteArrayOf(0x03) + asn1Length(content.size) + content
  }

  private fun asn1OctetString(data: ByteArray): ByteArray {
    return byteArrayOf(0x04) + asn1Length(data.size) + data
  }

  private fun asn1UTF8String(str: String): ByteArray {
    val bytes = str.toByteArray(Charsets.UTF_8)
    return byteArrayOf(0x0C.toByte()) + asn1Length(bytes.size) + bytes
  }

  private fun asn1UTCTime(date: Date): ByteArray {
    val sdf = java.text.SimpleDateFormat("yyMMddHHmmss'Z'", java.util.Locale.US)
    sdf.timeZone = java.util.TimeZone.getTimeZone("UTC")
    val bytes = sdf.format(date).toByteArray(Charsets.UTF_8)
    return byteArrayOf(0x17) + asn1Length(bytes.size) + bytes
  }

  private fun asn1ExplicitTag(tag: Int, content: ByteArray): ByteArray {
    val tagByte = (0xA0 or (tag and 0x1F)).toByte()
    return byteArrayOf(tagByte) + asn1Length(content.size) + content
  }

  // ---------------------------------------------------------------------------
  // Self-signed X.509 v3 certificate builder for AndroidKeyStore keys
  // ---------------------------------------------------------------------------

  private fun buildSelfSignedCertificateDER(privateKey: PrivateKey, appName: String = "Attestation Mobile"): ByteArray {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val existingCert = ks.getCertificate(keyAlias)
      ?: throw IllegalStateException("No certificate found for key alias: $keyAlias")
    val pubKeyBytes = existingCert.publicKey.encoded // SubjectPublicKeyInfo DER

    // Extract SubjectPublicKeyInfo from the existing cert's public key
    // pubKeyBytes is already a DER-encoded SubjectPublicKeyInfo
    val subjectPublicKeyInfo = pubKeyBytes

    // Serial number (from current time)
    val serialBytes = BigInteger.valueOf(System.currentTimeMillis()).toByteArray()
    val serialNumber = asn1Integer(serialBytes)

    // OID for ecdsaWithSHA256: 1.2.840.10045.4.3.2
    val ecdsaSha256OID: ByteArray = byteArrayOf(
      0x06, 0x08, 0x2A, 0x86.toByte(), 0x48, 0xCE.toByte(), 0x3D, 0x04, 0x03, 0x02
    )
    val signatureAlgorithm = asn1Sequence(ecdsaSha256OID)

    // Issuer and Subject: O=<appName>, CN=<appName> Self-Signed
    // Organization (O=) is required by c2pa post-sign verification
    val orgOID: ByteArray = byteArrayOf(0x06, 0x03, 0x55, 0x04, 0x0A)
    val orgValue = asn1UTF8String(appName)
    val orgAtv = asn1Sequence(orgOID + orgValue)
    val orgRdnSet = asn1Set(orgAtv)

    val cnOID: ByteArray = byteArrayOf(0x06, 0x03, 0x55, 0x04, 0x03)
    val cnValue = asn1UTF8String("$appName Self-Signed")
    val cnAtv = asn1Sequence(cnOID + cnValue)
    val cnRdnSet = asn1Set(cnAtv)

    val name = asn1Sequence(orgRdnSet + cnRdnSet)

    // Validity: now to +1 year
    val now = Date()
    val oneYear = Date(System.currentTimeMillis() + 365L * 24 * 60 * 60 * 1000)
    val notBefore = asn1UTCTime(now)
    val notAfter = asn1UTCTime(oneYear)
    val validity = asn1Sequence(notBefore + notAfter)

    // Version: v3 (explicit tag [0])
    val versionInt: ByteArray = byteArrayOf(0x02, 0x01, 0x02) // INTEGER 2 = v3
    val version = asn1ExplicitTag(0, versionInt)

    // --- Extensions ---

    // Key Usage (critical): digitalSignature (bit 0)
    // Key Usage is a BIT STRING where bit 0 = digitalSignature
    // Value: 0x80 = 10000000 (digitalSignature bit set), 7 unused bits
    val keyUsageOID: ByteArray = byteArrayOf(0x06, 0x03, 0x55, 0x1D, 0x0F) // 2.5.29.15
    val keyUsageCritical: ByteArray = byteArrayOf(0x01, 0x01, 0xFF.toByte()) // BOOLEAN TRUE
    val keyUsageBitString: ByteArray = byteArrayOf(0x03, 0x02, 0x07, 0x80.toByte()) // BIT STRING: 7 unused, 0x80
    val keyUsageValue = asn1OctetString(keyUsageBitString)
    val keyUsageExtension = asn1Sequence(keyUsageOID + keyUsageCritical + keyUsageValue)

    // Extended Key Usage: emailProtection (1.3.6.1.5.5.7.3.4)
    val ekuOID: ByteArray = byteArrayOf(0x06, 0x03, 0x55, 0x1D, 0x25) // 2.5.29.37
    val emailProtectionOID: ByteArray = byteArrayOf(
      0x06, 0x08, 0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x04
    )
    val ekuValueSeq = asn1Sequence(emailProtectionOID)
    val ekuValue = asn1OctetString(ekuValueSeq)
    val ekuExtension = asn1Sequence(ekuOID + ekuValue)

    // Authority Key Identifier (OID 2.5.29.35)
    // keyIdentifier = SHA-1 hash of the raw EC public key point
    val ecPubKey = existingCert.publicKey as ECPublicKey
    val w = ecPubKey.w
    val xBytes = w.affineX.toByteArray().let { b ->
      when {
        b.size == 32 -> b
        b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
        else -> ByteArray(32 - b.size) + b
      }
    }
    val yBytes = w.affineY.toByteArray().let { b ->
      when {
        b.size == 32 -> b
        b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
        else -> ByteArray(32 - b.size) + b
      }
    }
    val rawPoint = byteArrayOf(0x04) + xBytes + yBytes
    val keyIdHash = MessageDigest.getInstance("SHA-1").digest(rawPoint)
    val akiOID: ByteArray = byteArrayOf(0x06, 0x03, 0x55, 0x1D, 0x23) // 2.5.29.35
    val akiKeyId: ByteArray = byteArrayOf(0x80.toByte(), 0x14) + keyIdHash // [0] IMPLICIT OCTET STRING (20 bytes)
    val akiSeq = asn1Sequence(akiKeyId)
    val akiValue = asn1OctetString(akiSeq)
    val akiExtension = asn1Sequence(akiOID + akiValue)

    val extensions = asn1Sequence(akiExtension + keyUsageExtension + ekuExtension)
    val extensionsTagged = asn1ExplicitTag(3, extensions) // explicit tag [3]

    // TBSCertificate
    val tbsCertBytes = asn1Sequence(
      version
        + serialNumber
        + signatureAlgorithm
        + name        // issuer
        + validity
        + name        // subject (self-signed)
        + subjectPublicKeyInfo
        + extensionsTagged
    )

    // Sign the TBSCertificate
    val sig = Signature.getInstance("SHA256withECDSA")
    sig.initSign(privateKey)
    sig.update(tbsCertBytes)
    val tbsSignature = sig.sign()

    val signatureBitString = asn1BitString(tbsSignature)

    // Final Certificate SEQUENCE
    return asn1Sequence(
      tbsCertBytes
        + signatureAlgorithm
        + signatureBitString
    )
  }

  // ---------------------------------------------------------------------------
  // AndroidHardwareSigner: implements the UniFFI HardwareSigner interface
  // ---------------------------------------------------------------------------

  inner class AndroidHardwareSigner(
    private val privateKey: PrivateKey,
    private val module: RNAttestationMobileModule,
    private val appName: String = "Attestation Mobile"
  ) : HardwareSigner {

    override fun sign(data: ByteArray): ByteArray {
      val sig = Signature.getInstance("SHA256withECDSA")
      sig.initSign(privateKey)
      sig.update(data)
      return sig.sign()
    }

    override fun certificateDer(): ByteArray {
      return module.buildSelfSignedCertificateDER(privateKey, appName)
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
      val appName = if (params.hasKey("appName")) params.getString("appName") ?: "Attestation Mobile" else "Attestation Mobile"
      val now = java.time.Instant.now().toString()

      try {
        val (sourcePath, captureBytes) = loadSourcePhoto(params)
        val (privateKey, trustLevel) = getOrCreateSigningKey()
        val signer = AndroidHardwareSigner(privateKey, this@RNAttestationMobileModule, appName)

        var latitude: Double? = null
        var longitude: Double? = null
        if (params.hasKey("includeLocation") && params.getBoolean("includeLocation")) {
          if (params.hasKey("latitude") && params.hasKey("longitude")) {
            latitude = params.getDouble("latitude")
            longitude = params.getDouble("longitude")
          } else {
            val loc = fetchLocationWithTimeout()
            if (loc != null) {
              latitude = loc.latitude
              longitude = loc.longitude
            }
          }
        }

        val context = CaptureContext(
          appName = appName,
          deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}",
          osVersion = "Android ${Build.VERSION.RELEASE}",
          capturedAtIso8601 = now,
          trustLevel = trustLevel,
          nonce = nonce,
          latitude = latitude,
          longitude = longitude
        )

        // Single Rust call: hash -> build manifest -> sign (callback) -> embed JUMBF
        Log.d(TAG, "captureAndSignAtomic: calling buildAndSignC2pa with ${captureBytes.size} bytes")
        if (captureBytes.size >= 4) {
          Log.d(TAG, "captureAndSignAtomic: JPEG header = ${captureBytes.take(4).joinToString(" ") { String.format("%02X", it) }}")
        }
        val c2paResult = try {
          buildAndSignC2pa(
            jpegBytes = captureBytes,
            context = context,
            signer = signer
          )
        } catch (e: Throwable) {
          Log.e(TAG, "captureAndSignAtomic: buildAndSignC2pa failed", e)
          throw e
        }
        Log.d(TAG, "captureAndSignAtomic: buildAndSignC2pa succeeded, signed JPEG = ${c2paResult.signedJpeg.size} bytes")

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
        if (latitude != null && longitude != null) {
          val locationMap = Arguments.createMap()
          locationMap.putDouble("latitude", latitude)
          locationMap.putDouble("longitude", longitude)
          metadata.putMap("location", locationMap)
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

  @ReactMethod
  fun saveToGallery(params: ReadableMap, promise: Promise) {
    Thread {
      try {
        val filePath = params.getString("filePath")
        if (filePath.isNullOrBlank()) {
          promise.reject("E_SAVE_FAILED", "filePath is required")
          return@Thread
        }
        val sourceFile = File(filePath)
        Log.d(TAG, "saveToGallery: filePath=$filePath, exists=${sourceFile.exists()}, size=${if (sourceFile.exists()) sourceFile.length() else -1}")
        if (!sourceFile.exists()) {
          promise.reject("E_SAVE_FAILED", "File does not exist: $filePath")
          return@Thread
        }

        val fileName = params.getString("fileName")
          ?: "attested_${System.currentTimeMillis()}.jpg"
        Log.d(TAG, "saveToGallery: fileName=$fileName")

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          saveToGalleryQ(sourceFile, fileName, promise)
        } else {
          saveToGalleryPreQ(sourceFile, fileName, promise)
        }
      } catch (t: Throwable) {
        Log.e(TAG, "saveToGallery failed", t)
        promise.reject("E_SAVE_FAILED", "Failed to save to gallery: ${t.message}", t)
      }
    }.start()
  }

  private fun saveToGalleryQ(sourceFile: File, fileName: String, promise: Promise) {
    val resolver = reactApplicationContext.contentResolver
    val contentValues = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
      put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
      put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Attestation")
      put(MediaStore.Images.Media.IS_PENDING, 1)
    }

    Log.d(TAG, "saveToGalleryQ: inserting MediaStore entry")
    val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, contentValues)
    if (uri == null) {
      Log.e(TAG, "saveToGalleryQ: MediaStore.insert returned null")
      promise.reject("E_SAVE_FAILED", "Failed to create MediaStore entry")
      return
    }
    Log.d(TAG, "saveToGalleryQ: MediaStore entry created: $uri")

    var success = false
    try {
      val outputStream = resolver.openOutputStream(uri)
      if (outputStream == null) {
        Log.e(TAG, "saveToGalleryQ: openOutputStream returned null for $uri")
        promise.reject("E_SAVE_FAILED", "Failed to open output stream")
        return
      }
      outputStream.use { os ->
        sourceFile.inputStream().use { inputStream ->
          val bytesCopied = inputStream.copyTo(os)
          Log.d(TAG, "saveToGalleryQ: copied $bytesCopied bytes")
        }
      }
      success = true
    } finally {
      if (success) {
        val updateValues = ContentValues().apply {
          put(MediaStore.Images.Media.IS_PENDING, 0)
          put(MediaStore.Images.Media.DATE_TAKEN, System.currentTimeMillis())
          put(MediaStore.Images.Media.SIZE, sourceFile.length())
        }
        val rowsUpdated = resolver.update(uri, updateValues, null, null)
        Log.d(TAG, "saveToGalleryQ: IS_PENDING cleared, rowsUpdated=$rowsUpdated")
        if (rowsUpdated == 0) {
          Log.w(TAG, "saveToGalleryQ: update() returned 0 — IS_PENDING may not have been cleared")
        }
      } else {
        // Clean up orphaned pending entry
        resolver.delete(uri, null, null)
        Log.d(TAG, "saveToGalleryQ: cleaned up failed MediaStore entry")
      }
    }

    Log.d(TAG, "saveToGalleryQ: saved successfully to $uri")
    val result = Arguments.createMap()
    result.putString("uri", uri.toString())
    promise.resolve(result)
  }

  private fun saveToGalleryPreQ(sourceFile: File, fileName: String, promise: Promise) {
    val picturesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
    val attestationDir = File(picturesDir, "Attestation")
    if (!attestationDir.exists()) {
      val created = attestationDir.mkdirs()
      Log.d(TAG, "saveToGalleryPreQ: created dir=${attestationDir.absolutePath}, success=$created")
      if (!created) {
        promise.reject("E_SAVE_FAILED", "Failed to create Pictures/Attestation directory")
        return
      }
    }

    val destFile = File(attestationDir, fileName)
    Log.d(TAG, "saveToGalleryPreQ: copying to ${destFile.absolutePath}")
    sourceFile.inputStream().use { input ->
      destFile.outputStream().use { output ->
        val bytesCopied = input.copyTo(output)
        Log.d(TAG, "saveToGalleryPreQ: copied $bytesCopied bytes")
      }
    }

    // Notify media scanner so the file appears in gallery
    MediaScannerConnection.scanFile(
      reactApplicationContext,
      arrayOf(destFile.absolutePath),
      arrayOf("image/jpeg")
    ) { path, scannedUri ->
      Log.d(TAG, "saveToGalleryPreQ: media scan complete, path=$path, uri=$scannedUri")
    }

    Log.d(TAG, "saveToGalleryPreQ: saved successfully to ${destFile.absolutePath}")
    val result = Arguments.createMap()
    result.putString("uri", destFile.absolutePath)
    promise.resolve(result)
  }
}

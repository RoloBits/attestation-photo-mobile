import Foundation
import CoreLocation
import CryptoKit
import Photos
import React
import Security
import UIKit

// ---------------------------------------------------------------------------
// One-shot GPS fetcher (semaphore-based, dispatches to main for CLLocationManager)
// ---------------------------------------------------------------------------

private class OneShotLocationFetcher: NSObject, CLLocationManagerDelegate {
  private let semaphore = DispatchSemaphore(value: 0)
  private var result: CLLocation?
  private var manager: CLLocationManager?

  func fetch() -> CLLocation? {
    let status: CLAuthorizationStatus
    if #available(iOS 14.0, *) {
      let mgr = CLLocationManager()
      status = mgr.authorizationStatus
    } else {
      status = CLLocationManager.authorizationStatus()
    }

    guard status == .authorizedWhenInUse || status == .authorizedAlways else {
      return nil
    }

    DispatchQueue.main.async { [self] in
      let mgr = CLLocationManager()
      mgr.delegate = self
      mgr.desiredAccuracy = kCLLocationAccuracyBest
      self.manager = mgr
      mgr.requestLocation()
    }

    let timeout = semaphore.wait(timeout: .now() + 5.0)
    if timeout == .timedOut {
      DispatchQueue.main.async { [self] in
        manager?.delegate = nil
        manager = nil
      }
    }
    return result
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    result = locations.last
    manager.delegate = nil
    self.manager = nil
    semaphore.signal()
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    result = nil
    manager.delegate = nil
    self.manager = nil
    semaphore.signal()
  }
}

@objc(RNAttestationMobile)
class RNAttestationMobile: NSObject {
  private let keyAlias = "com.attestation.mobile.signingkey"

  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }

  private var keyTagData: Data {
    keyAlias.data(using: .utf8) ?? Data()
  }

  private func isPhysicalDevice() -> Bool {
    #if targetEnvironment(simulator)
      return false
    #else
      return true
    #endif
  }

  private func loadPrivateKey() -> SecKey? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: keyTagData,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true
    ]

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess else { return nil }
    // swiftlint:disable:next force_cast
    return item.map { $0 as! SecKey }
  }

  private func createPrivateKey() throws -> SecKey {
    guard let accessControl = SecAccessControlCreateWithFlags(
      nil,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      [.privateKeyUsage],
      nil
    ) else {
      throw NSError(
        domain: "RNAttestationMobile",
        code: -4,
        userInfo: [NSLocalizedDescriptionKey: "Cannot create access control"]
      )
    }

    var attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: keyTagData,
        kSecAttrAccessControl as String: accessControl
      ]
    ]

    #if !targetEnvironment(simulator)
      attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
    #endif

    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw (error?.takeRetainedValue() as Error?) ?? NSError(
        domain: "RNAttestationMobile",
        code: -1,
        userInfo: [NSLocalizedDescriptionKey: "Unable to create key pair"]
      )
    }
    return key
  }

  private func getOrCreatePrivateKey() throws -> SecKey {
    if let key = loadPrivateKey() {
      return key
    }
    return try createPrivateKey()
  }

  private func currentTrustLevel() -> String {
    isPhysicalDevice() ? "secure_enclave" : "software_fallback"
  }

  private func signMessage(privateKey: SecKey, payload: Data) throws -> Data {
    let algorithm = SecKeyAlgorithm.ecdsaSignatureMessageX962SHA256
    guard SecKeyIsAlgorithmSupported(privateKey, .sign, algorithm) else {
      throw NSError(
        domain: "RNAttestationMobile",
        code: -2,
        userInfo: [NSLocalizedDescriptionKey: "ECDSA signing algorithm unsupported"]
      )
    }
    var error: Unmanaged<CFError>?
    guard let sig = SecKeyCreateSignature(
      privateKey,
      algorithm,
      payload as CFData,
      &error
    ) else {
      throw (error?.takeRetainedValue() as Error?) ?? NSError(
        domain: "RNAttestationMobile",
        code: -3,
        userInfo: [NSLocalizedDescriptionKey: "Signature operation failed"]
      )
    }
    return sig as Data
  }

  private func loadSourcePhoto(_ params: NSDictionary) throws -> (path: String, bytes: Data) {
    guard let sourcePath = params["sourcePhotoPath"] as? String else {
      throw NSError(
        domain: "RNAttestationMobile",
        code: -10,
        userInfo: [NSLocalizedDescriptionKey: "sourcePhotoPath is required"]
      )
    }
    let url = URL(fileURLWithPath: sourcePath)
    let data = try Data(contentsOf: url)
    guard !data.isEmpty else {
      throw NSError(
        domain: "RNAttestationMobile",
        code: -11,
        userInfo: [NSLocalizedDescriptionKey: "source photo is empty"]
      )
    }
    return (path: sourcePath, bytes: data)
  }

  private func sha256Hex(data: Data) -> String {
    let digest = SHA256.hash(data: data)
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  // ---------------------------------------------------------------------------
  // Self-signed X.509 certificate builder for Secure Enclave keys
  // ---------------------------------------------------------------------------

  /// Build a self-signed X.509 v3 certificate wrapping a Secure Enclave public key.
  /// The certificate uses the same Secure Enclave key to sign the TBSCertificate.
  private func buildSelfSignedCertificateDER(privateKey: SecKey, appName: String = "Attestation Mobile") throws -> Data {
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
      throw NSError(
        domain: "RNAttestationMobile",
        code: -20,
        userInfo: [NSLocalizedDescriptionKey: "Cannot extract public key"]
      )
    }

    var error: Unmanaged<CFError>?
    guard let pubKeyData = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      throw (error?.takeRetainedValue() as Error?) ?? NSError(
        domain: "RNAttestationMobile",
        code: -21,
        userInfo: [NSLocalizedDescriptionKey: "Cannot export public key"]
      )
    }

    // pubKeyData is X9.63 uncompressed: 04 || x (32 bytes) || y (32 bytes)
    // Build a SubjectPublicKeyInfo wrapping EC P-256

    // OID for EC public key: 1.2.840.10045.2.1
    let ecPublicKeyOID: [UInt8] = [0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01]
    // OID for P-256 curve: 1.2.840.10045.3.1.7
    let p256OID: [UInt8] = [0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07]
    // Algorithm identifier SEQUENCE
    let algorithmIdentifier = asn1Sequence(ecPublicKeyOID + p256OID)
    // Public key as BIT STRING (0 unused bits prefix)
    let pubKeyBitString = asn1BitString(Data(pubKeyData))
    let subjectPublicKeyInfo = asn1Sequence(algorithmIdentifier + pubKeyBitString)

    // Serial number (random 8 bytes)
    var serial = [UInt8](repeating: 0, count: 8)
    _ = SecRandomCopyBytes(kSecRandomDefault, serial.count, &serial)
    serial[0] &= 0x7F  // Ensure positive
    let serialNumber = asn1Integer(Data(serial))

    // OID for ecdsaWithSHA256: 1.2.840.10045.4.3.2
    let ecdsaSha256OID: [UInt8] = [0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02]
    let signatureAlgorithm = asn1Sequence(ecdsaSha256OID)

    // Issuer and Subject: O=<appName>, CN=<appName> Self-Signed
    // Organization (O=) is required by c2pa post-sign verification
    let orgOID: [UInt8] = [0x06, 0x03, 0x55, 0x04, 0x0A]
    let orgValue = asn1UTF8String(appName)
    let orgAtv = asn1Sequence(orgOID + orgValue)
    let orgRdnSet = asn1Set(orgAtv)

    let cnOID: [UInt8] = [0x06, 0x03, 0x55, 0x04, 0x03]
    let cnValue = asn1UTF8String("\(appName) Self-Signed")
    let cnAtv = asn1Sequence(cnOID + cnValue)
    let cnRdnSet = asn1Set(cnAtv)

    let name = asn1Sequence(orgRdnSet + cnRdnSet)

    // Validity: now to +1 year
    let now = Date()
    let oneYear = Calendar.current.date(byAdding: .year, value: 1, to: now)!
    let notBefore = asn1UTCTime(now)
    let notAfter = asn1UTCTime(oneYear)
    let validity = asn1Sequence(notBefore + notAfter)

    // Version: v3 (explicit tag [0])
    let versionInt: [UInt8] = [0x02, 0x01, 0x02] // INTEGER 2 = v3
    let version: [UInt8] = [0xA0, UInt8(versionInt.count)] + versionInt

    // --- Extensions ---

    // Key Usage (critical): digitalSignature (bit 0)
    let keyUsageOID: [UInt8] = [0x06, 0x03, 0x55, 0x1D, 0x0F] // 2.5.29.15
    let keyUsageCritical: [UInt8] = [0x01, 0x01, 0xFF] // BOOLEAN TRUE
    let keyUsageBitString: [UInt8] = [0x03, 0x02, 0x07, 0x80] // BIT STRING: 7 unused, 0x80
    let keyUsageValue = asn1OctetString(keyUsageBitString)
    let keyUsageExtension = asn1Sequence(keyUsageOID + keyUsageCritical + keyUsageValue)

    // Extended Key Usage: emailProtection (1.3.6.1.5.5.7.3.4)
    let ekuOID: [UInt8] = [0x06, 0x03, 0x55, 0x1D, 0x25] // 2.5.29.37
    let emailProtectionOID: [UInt8] = [0x06, 0x08, 0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x04]
    let ekuValueSeq = asn1Sequence(emailProtectionOID)
    let ekuValue = asn1OctetString(ekuValueSeq)
    let ekuExtension = asn1Sequence(ekuOID + ekuValue)

    // Authority Key Identifier (OID 2.5.29.35)
    // keyIdentifier = SHA-1 hash of the raw public key (X9.63 uncompressed point)
    let keyIdDigest = Insecure.SHA1.hash(data: pubKeyData)
    let keyId: [UInt8] = Array(keyIdDigest)
    let akiOID: [UInt8] = [0x06, 0x03, 0x55, 0x1D, 0x23] // 2.5.29.35
    let akiKeyId: [UInt8] = [0x80, 0x14] + keyId // [0] IMPLICIT OCTET STRING (20 bytes)
    let akiSeq = asn1Sequence(akiKeyId)
    let akiValue = asn1OctetString(akiSeq)
    let akiExtension = asn1Sequence(akiOID + akiValue)

    let extensions = asn1Sequence(akiExtension + keyUsageExtension + ekuExtension)
    let extensionsTagged = asn1ExplicitTag(3, extensions) // explicit tag [3]

    // TBSCertificate
    let tbsCertBytes = asn1Sequence(
      version
      + serialNumber
      + signatureAlgorithm
      + name        // issuer
      + validity
      + name        // subject (self-signed, same as issuer)
      + subjectPublicKeyInfo
      + extensionsTagged
    )

    // Sign the TBSCertificate with the Secure Enclave key
    let tbsData = Data(tbsCertBytes)
    let tbsSignature = try signMessage(privateKey: privateKey, payload: tbsData)

    // Wrap signature as BIT STRING
    let signatureBitString = asn1BitString(tbsSignature)

    // Final Certificate SEQUENCE
    let certificate = asn1Sequence(
      tbsCertBytes
      + signatureAlgorithm
      + signatureBitString
    )

    return Data(certificate)
  }

  // ASN.1 DER encoding helpers
  private func asn1Length(_ length: Int) -> [UInt8] {
    precondition(length >= 0 && length <= 65535, "ASN.1 length out of supported range")
    if length < 128 {
      return [UInt8(length)]
    } else if length < 256 {
      return [0x81, UInt8(length)]
    } else {
      return [0x82, UInt8(length >> 8), UInt8(length & 0xFF)]
    }
  }

  private func asn1Sequence(_ content: [UInt8]) -> [UInt8] {
    return [0x30] + asn1Length(content.count) + content
  }

  private func asn1Set(_ content: [UInt8]) -> [UInt8] {
    return [0x31] + asn1Length(content.count) + content
  }

  private func asn1Integer(_ data: Data) -> [UInt8] {
    var bytes = [UInt8](data)
    // Prepend 0x00 if high bit is set (to keep positive)
    if let first = bytes.first, first & 0x80 != 0 {
      bytes.insert(0x00, at: 0)
    }
    return [0x02] + asn1Length(bytes.count) + bytes
  }

  private func asn1BitString(_ data: Data) -> [UInt8] {
    let bytes = [UInt8](data)
    let content = [UInt8(0)] + bytes // 0 unused bits
    return [0x03] + asn1Length(content.count) + content
  }

  private func asn1UTF8String(_ string: String) -> [UInt8] {
    let bytes = [UInt8](string.utf8)
    return [0x0C] + asn1Length(bytes.count) + bytes
  }

  private func asn1UTCTime(_ date: Date) -> [UInt8] {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyMMddHHmmss'Z'"
    formatter.timeZone = TimeZone(identifier: "UTC")
    let str = formatter.string(from: date)
    let bytes = [UInt8](str.utf8)
    return [0x17] + asn1Length(bytes.count) + bytes
  }

  private func asn1OctetString(_ data: [UInt8]) -> [UInt8] {
    return [0x04] + asn1Length(data.count) + data
  }

  private func asn1ExplicitTag(_ tag: UInt8, _ content: [UInt8]) -> [UInt8] {
    let tagByte = 0xA0 | (tag & 0x1F)
    return [tagByte] + asn1Length(content.count) + content
  }

  // ---------------------------------------------------------------------------
  // SecureEnclaveHardwareSigner: implements the UniFFI HardwareSigner protocol
  // ---------------------------------------------------------------------------

  class SecureEnclaveHardwareSigner: HardwareSigner {
    private let privateKey: SecKey
    private let module: RNAttestationMobile
    private let appName: String

    init(privateKey: SecKey, module: RNAttestationMobile, appName: String = "Attestation Mobile") {
      self.privateKey = privateKey
      self.module = module
      self.appName = appName
    }

    func sign(data: Data) throws -> Data {
      return try module.signMessage(privateKey: privateKey, payload: data)
    }

    func certificateDer() throws -> Data {
      return try module.buildSelfSignedCertificateDER(privateKey: privateKey, appName: appName)
    }
  }

  // ---------------------------------------------------------------------------
  // React Native methods
  // ---------------------------------------------------------------------------

  @objc
  func getAttestationStatus(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      _ = try getOrCreatePrivateKey()
      resolve([
        "isPhysicalDevice": isPhysicalDevice(),
        "isCompromised": false,
        "trustLevel": currentTrustLevel()
      ])
    } catch {
      reject("E_ATTESTATION_FAILED", "Hardware key unavailable", error)
    }
  }

  @objc
  func ensureHardwareKey(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      _ = try getOrCreatePrivateKey()
      resolve(["trustLevel": currentTrustLevel()])
    } catch {
      reject("E_ATTESTATION_FAILED", "Could not provision hardware key", error)
    }
  }

  @objc
  func signPayload(
    _ params: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let payloadB64 = params["payloadBase64"] as? String,
          let payload = Data(base64Encoded: payloadB64) else {
      reject("E_SIGNING_FAILED", "Invalid payloadBase64", nil)
      return
    }
    do {
      let key = try getOrCreatePrivateKey()
      let signature = try signMessage(privateKey: key, payload: payload)
      resolve([
        "signatureBase64": signature.base64EncodedString(),
        "trustLevel": currentTrustLevel()
      ])
    } catch {
      reject("E_SIGNING_FAILED", "Hardware signing failed", error)
    }
  }

  @objc
  func hashPhotoAtPath(
    _ params: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let sourcePath = params["sourcePhotoPath"] as? String else {
      reject("E_CAPTURE_FAILED", "sourcePhotoPath is required", nil)
      return
    }
    do {
      let sourceData = try Data(contentsOf: URL(fileURLWithPath: sourcePath))
      if sourceData.isEmpty {
        reject("E_CAPTURE_FAILED", "source image is empty", nil)
        return
      }
      resolve(["sha256Hex": sha256Hex(data: sourceData)])
    } catch {
      reject("E_CAPTURE_FAILED", "Failed to hash source image", error)
    }
  }

  @objc
  func captureAndSignAtomic(
    _ params: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .userInitiated).async { [self] in
      let nonce = params["nonce"] as? String
      let appName = (params["appName"] as? String) ?? "Attestation Mobile"
      let now = ISO8601DateFormatter().string(from: Date())

      do {
        let source = try loadSourcePhoto(params)
        let privateKey = try getOrCreatePrivateKey()
        let signer = SecureEnclaveHardwareSigner(privateKey: privateKey, module: self, appName: appName)

        var latitude: NSNumber? = nil
        var longitude: NSNumber? = nil
        if let includeLocation = params["includeLocation"] as? Bool, includeLocation {
          if let lat = params["latitude"] as? NSNumber, let lon = params["longitude"] as? NSNumber {
            latitude = lat
            longitude = lon
          } else {
            if let loc = OneShotLocationFetcher().fetch() {
              latitude = NSNumber(value: loc.coordinate.latitude)
              longitude = NSNumber(value: loc.coordinate.longitude)
            }
          }
        }

        let context = CaptureContext(
          appName: appName,
          deviceModel: "Apple \(UIDevice.current.model)",
          osVersion: "iOS \(UIDevice.current.systemVersion)",
          capturedAtIso8601: now,
          trustLevel: currentTrustLevel(),
          nonce: nonce,
          latitude: latitude?.doubleValue,
          longitude: longitude?.doubleValue
        )

        // Single Rust call: hash -> build manifest -> sign (callback) -> embed JUMBF
        let result = try buildAndSignC2pa(
          jpegBytes: source.bytes,
          context: context,
          signer: signer
        )

        // Atomic write of signed JPEG (replaces unsigned original)
        try result.signedJpeg.write(
          to: URL(fileURLWithPath: source.path),
          options: .atomic
        )

        let metadata: [String: Any] = {
          var m: [String: Any] = [
            "deviceModel": "Apple \(UIDevice.current.model)",
            "osVersion": "iOS \(UIDevice.current.systemVersion)",
            "capturedAtIso8601": now,
            "sourceSha256": result.assetHashHex,
            "pipelineMode": "c2pa-atomic"
          ]
          if let nonce = nonce { m["nonce"] = nonce }
          if let lat = latitude, let lon = longitude {
            m["location"] = ["latitude": lat.doubleValue, "longitude": lon.doubleValue]
          }
          return m
        }()

        resolve([
          "path": source.path,
          "signature": result.assetHashHex,
          "algorithm": "ECDSA_P256_SHA256",
          "manifestFormat": "c2pa-jumbf",
          "trustLevel": currentTrustLevel(),
          "embeddedManifest": true,
          "metadata": metadata
        ])
      } catch {
        reject("E_CAPTURE_FAILED", "captureAndSignAtomic failed: \(error.localizedDescription)", error)
      }
    }
  }

  @objc
  func saveToGallery(
    _ params: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let filePath = params["filePath"] as? String else {
      reject("E_SAVE_FAILED", "filePath is required", nil)
      return
    }
    let fileURL = URL(fileURLWithPath: filePath)
    guard FileManager.default.fileExists(atPath: filePath) else {
      reject("E_SAVE_FAILED", "File does not exist: \(filePath)", nil)
      return
    }

    PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
      guard status == .authorized || status == .limited else {
        reject("E_SAVE_FAILED", "Photo library permission denied", nil)
        return
      }
      PHPhotoLibrary.shared().performChanges({
        PHAssetCreationRequest.forAsset().addResource(with: .photo, fileURL: fileURL, options: nil)
      }) { success, error in
        if success {
          resolve(["saved": true])
        } else {
          reject("E_SAVE_FAILED", error?.localizedDescription ?? "Unknown error", error)
        }
      }
    }
  }
}

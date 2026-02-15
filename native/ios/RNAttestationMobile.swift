import Foundation
import CryptoKit
import React
import Security
import UIKit

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
    return item as? SecKey
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
  private func buildSelfSignedCertificateDER(privateKey: SecKey) throws -> Data {
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

    // Issuer and Subject: CN=AtomicC2PA Self-Signed
    let cnOID: [UInt8] = [0x06, 0x03, 0x55, 0x04, 0x03]
    let cnValue = asn1UTF8String("AtomicC2PA Self-Signed")
    let atv = asn1Sequence(cnOID + cnValue)
    let rdnSet = asn1Set(atv)
    let name = asn1Sequence(rdnSet)

    // Validity: now to +1 year
    let now = Date()
    let oneYear = Calendar.current.date(byAdding: .year, value: 1, to: now)!
    let notBefore = asn1UTCTime(now)
    let notAfter = asn1UTCTime(oneYear)
    let validity = asn1Sequence(notBefore + notAfter)

    // Version: v3 (explicit tag [0])
    let versionInt: [UInt8] = [0x02, 0x01, 0x02] // INTEGER 2 = v3
    let version: [UInt8] = [0xA0, UInt8(versionInt.count)] + versionInt

    // TBSCertificate
    let tbsCertBytes = asn1Sequence(
      version
      + serialNumber
      + signatureAlgorithm
      + name        // issuer
      + validity
      + name        // subject (self-signed, same as issuer)
      + subjectPublicKeyInfo
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

  // ---------------------------------------------------------------------------
  // SecureEnclaveHardwareSigner: implements the UniFFI HardwareSigner protocol
  // ---------------------------------------------------------------------------

  class SecureEnclaveHardwareSigner: HardwareSignerProtocol {
    private let privateKey: SecKey
    private let module: RNAttestationMobile

    init(privateKey: SecKey, module: RNAttestationMobile) {
      self.privateKey = privateKey
      self.module = module
    }

    func sign(data: Data) throws -> Data {
      return try module.signMessage(privateKey: privateKey, payload: data)
    }

    func certificateDer() throws -> Data {
      return try module.buildSelfSignedCertificateDER(privateKey: privateKey)
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
      let now = ISO8601DateFormatter().string(from: Date())

      do {
        let source = try loadSourcePhoto(params)
        let privateKey = try getOrCreatePrivateKey()
        let signer = SecureEnclaveHardwareSigner(privateKey: privateKey, module: self)

        var latitude: NSNumber? = nil
        var longitude: NSNumber? = nil
        if let includeLocation = params["includeLocation"] as? Bool, includeLocation {
          latitude = params["latitude"] as? NSNumber
          longitude = params["longitude"] as? NSNumber
        }

        let context = CaptureContext(
          deviceModel: UIDevice.current.model,
          osVersion: UIDevice.current.systemVersion,
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
            "deviceModel": UIDevice.current.model,
            "osVersion": UIDevice.current.systemVersion,
            "capturedAtIso8601": now,
            "sourceSha256": result.assetHashHex,
            "pipelineMode": "c2pa-atomic"
          ]
          if let nonce = nonce { m["nonce"] = nonce }
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
}

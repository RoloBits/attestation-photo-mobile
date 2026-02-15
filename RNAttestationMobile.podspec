require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "RNAttestationMobile"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["repository"]["url"]
  s.license      = package["license"]
  s.authors      = "RoloBits"
  s.source       = { :git => package["repository"]["url"], :tag => s.version }
  s.platform     = :ios, "14.0"

  s.source_files = "native/ios/**/*.{swift,m,h}"
  s.preserve_paths = "native/ios/attestation_mobileFFI.modulemap",
                     "native/ios/attestation_mobileFFI.h"

  s.script_phase = {
    :name => "Build Rust Static Library",
    :script => 'bash "${PODS_TARGET_SRCROOT}/scripts/build-rust-ios.sh"',
    :execution_position => :before_compile,
  }

  s.pod_target_xcconfig = {
    "SWIFT_INCLUDE_PATHS" => '"${PODS_TARGET_SRCROOT}/native/ios"',
    "HEADER_SEARCH_PATHS" => '"${PODS_TARGET_SRCROOT}/native/ios"',
  }

  # Link the Rust static library into the final app binary
  s.user_target_xcconfig = {
    "LIBRARY_SEARCH_PATHS" => [
      '"${PODS_ROOT}/../../node_modules/@rolobits/attestation-photo-mobile/rust/target/universal-ios/release"',
      '"${PODS_ROOT}/../../node_modules/@rolobits/attestation-photo-mobile/rust/target/universal-ios/debug"',
    ].join(" "),
    "OTHER_LDFLAGS" => "-lattestation_mobile_core",
  }

  s.dependency "React-Core"
  s.swift_version = "5.9"
end

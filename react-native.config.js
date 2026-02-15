module.exports = {
  dependency: {
    platforms: {
      ios: {
        podspecPath: "./RNAttestationMobile.podspec",
      },
      android: {
        sourceDir: "./native/android",
        packageImportPath:
          "import com.attestation.mobile.RNAttestationMobilePackage;",
        packageInstance: "new RNAttestationMobilePackage()",
      },
    },
  },
};

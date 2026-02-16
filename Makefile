# ─── Config ───────────────────────────────────────────────────────────────────
SHELL          := /bin/bash
WORKSPACE      := example/ios/AttestationExample.xcworkspace
SCHEME         := AttestationExample
CONFIGURATION  := Release
BUNDLE_ID      := org.reactjs.native.example.AttestationExample
ANDROID_HOME   := $(HOME)/Library/Android/sdk

# Find node from nvm (use default version)
NODE_DIR       := $(shell source $(HOME)/.nvm/nvm.sh 2>/dev/null && dirname $$(which node))

# Export PATH for all recipes
export PATH    := $(NODE_DIR):$(ANDROID_HOME)/platform-tools:$(ANDROID_HOME)/cmdline-tools/latest/bin:$(HOME)/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

.PHONY: help lib pods ios-build ios-run ios-open android-apk android-install devices clean

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ─── Shared ───────────────────────────────────────────────────────────────────
lib: ## Build the TypeScript library
	npm run build

# ─── iOS ──────────────────────────────────────────────────────────────────────
pods: ## Install CocoaPods dependencies
	cd example/ios && pod install

ios-build: lib pods ## Build iOS release for connected iPhone
	@DEVICE=$$(xcrun xctrace list devices 2>/dev/null \
		| grep -v -e Simulator -e MacBook -e '^==' -e '^$$' \
		| head -1); \
	if [ -z "$$DEVICE" ]; then \
		printf "\n  \033[31mNo iPhone connected.\033[0m Plug in your device via USB and try again.\n"; \
		printf "  Run 'make devices' to see what is detected.\n\n"; \
		exit 1; \
	fi; \
	UDID=$$(echo "$$DEVICE" | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}'); \
	if [ -z "$$UDID" ]; then \
		printf "\n  \033[31mCould not parse device UDID from:\033[0m $$DEVICE\n\n"; \
		exit 1; \
	fi; \
	printf "\n  \033[36mBuilding for:\033[0m $$DEVICE\n\n"; \
	xcodebuild \
		-workspace $(WORKSPACE) \
		-scheme $(SCHEME) \
		-configuration $(CONFIGURATION) \
		-destination "id=$$UDID" \
		-allowProvisioningUpdates \
		-derivedDataPath example/ios/build \
		CODE_SIGN_IDENTITY="Apple Development" \
		CODE_SIGNING_ALLOWED=YES

ios-run: ios-build ## Build, install and launch on connected iPhone
	@UDID=$$(xcrun xctrace list devices 2>/dev/null \
		| grep -v -e Simulator -e MacBook -e '^==' -e '^$$' \
		| head -1 \
		| grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}'); \
	printf "\n  \033[36mInstalling on device...\033[0m\n"; \
	xcrun devicectl device install app \
		--device "$$UDID" \
		"example/ios/build/Build/Products/$(CONFIGURATION)-iphoneos/$(SCHEME).app"; \
	printf "  \033[36mLaunching...\033[0m\n"; \
	xcrun devicectl device process launch \
		--device "$$UDID" \
		$(BUNDLE_ID); \
	printf "\n  \033[32mDone!\033[0m\n"; \
	printf "  If this is the first run, trust the developer on your iPhone:\n"; \
	printf "    Settings > General > VPN & Device Management > your profile > Trust\n\n"

ios-open: ## Open Xcode workspace (for manual signing setup)
	open $(WORKSPACE)

# ─── Android ──────────────────────────────────────────────────────────────────
android-apk: lib ## Build Android release APK
	cd example/android && ./gradlew assembleRelease
	@APK=$$(find example/android/app/build/outputs/apk/release -name '*.apk' | head -1) && \
		printf "\n  \033[32mAPK:\033[0m $$APK\n\n"

android-install: android-apk ## Build and install APK on connected Android device
	adb install -r $$(find example/android/app/build/outputs/apk/release -name '*.apk' | head -1)

# ─── Util ─────────────────────────────────────────────────────────────────────
devices: ## List connected iOS and Android devices
	@printf "\n  \033[36miOS devices:\033[0m\n"
	@xcrun xctrace list devices 2>/dev/null | \
		awk '/^==/{s=$$0;next} s=="== Devices ==" && !/MacBook/{print "    " $$0}' || true
	@printf "\n  \033[36mAndroid devices:\033[0m\n"
	@adb devices 2>/dev/null | tail -n +2 | awk 'NF{print "    " $$0}' || printf "    (none)\n"
	@printf "\n"

clean: ## Remove all build artifacts
	rm -rf example/ios/build
	rm -rf example/android/app/build
	rm -rf dist

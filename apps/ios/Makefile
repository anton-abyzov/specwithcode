# SpecWithCode for iPhone. Run from apps/ios.

PROJECT := SpecWithCode.xcodeproj
SCHEME := SpecWithCode
DESTINATION ?= generic/platform=iOS Simulator
DERIVED_DATA ?= build/DerivedData

.PHONY: project build test-core test-app shots fault-shots sim sim-build sim-test sim-smoke sim-run sim-stop

# The device viewer's stream script is bundled from the shared transport first.
project:
	node Tools/generate-device-stream.mjs
	xcodegen generate

build: project
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination '$(DESTINATION)' -derivedDataPath $(DERIVED_DATA) build

test-core:
	cd SWCKit && swift test

# Unit tests of the app shell (App/Tests), on the simulator you name.
test-app:
	@if [ -z "$(SIM_UDID)" ]; then \
	  echo "usage: make test-app SIM_UDID=<simulator-udid>   (list them: xcrun simctl list devices)" >&2; exit 2; \
	fi
	node Tools/generate-device-stream.mjs
	xcodegen generate
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination 'platform=iOS Simulator,id=$(SIM_UDID)' -derivedDataPath $(DERIVED_DATA) -only-testing:SpecWithCodeTests test

# Screenshots install into, relaunch and restyle a simulator, so it must be named.
shots:
	@if [ -z "$(SIM_UDID)" ]; then \
	  echo "usage: make shots SIM_UDID=<simulator-udid>   (list them: xcrun simctl list devices booted)" >&2; exit 2; \
	fi
	@if [ ! -f Tools/shots.sh ]; then echo "Tools/shots.sh not found" >&2; exit 1; fi
	bash Tools/shots.sh '$(SIM_UDID)'

# Machine-outage sequences from the fleet fixture; run after `make shots` installs the app.
fault-shots:
	@if [ -z "$(SIM_UDID)" ]; then \
	  echo "usage: make fault-shots SIM_UDID=<simulator-udid>" >&2; exit 2; \
	fi
	bash Tools/fault-shots.sh '$(SIM_UDID)'

# Simulator-first: one dedicated simulator ("SWC Sim-First", or SIM_NAME), booted
# headless, so routine checks never need the phone or a Simulator window.
# Evidence (result bundles, screenshots, logs) goes to build/sim-first.
sim:
	bash Tools/sim.sh ensure

sim-build:
	bash Tools/sim.sh build

# ONLY narrows the run, for example ONLY=SpecWithCodeUITests/AideHistoryUITests.
sim-test:
	bash Tools/sim.sh test $(if $(ONLY),-only-testing:$(ONLY))

sim-smoke:
	bash Tools/sim.sh smoke

# FIXTURE and ROUTE as in fixture mode, for example FIXTURE=long ROUTE=thread.
sim-run:
	bash Tools/sim.sh run '$(or $(FIXTURE),default)' '$(ROUTE)'

sim-stop:
	bash Tools/sim.sh stop

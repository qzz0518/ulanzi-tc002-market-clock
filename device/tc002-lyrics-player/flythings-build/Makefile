# Headless reproduction of the FlyThings Eclipse CDT managed build.
# Produces libzkgui.so (the app shared object the framework loads), matching
# the flags reverse-engineered from the app's .cproject.

TOOLCHAIN := toolchain/toolchain
CXX       := $(TOOLCHAIN)/bin/arm-linux-gnueabihf-g++
APP       ?= ../app
PKG       := packages
OUT       ?= libzkgui.so
# Object directory, per app. Three firmwares share this build dir; with a single
# hardcoded 'build/', switching APP without `make clean` silently links the
# previous app's objects into the new .so — it builds, it loads, and it runs the
# wrong firmware. Namespacing the objects makes that impossible.
BUILD_DIR ?= build

DEP_INC := easyui base-utility log zkhardware transfer-protocols audio-utility base-json ffmpeg z
# BOOST_INC points at the isolated boost/ subtree provided by the Docker image.
BOOST_INC ?= /opt/boost
# SHARED is the device/ root, so the generated glyph tables can be included as
# "shared-visual/CjkFont.h" from any firmware. One copy in the repo is what keeps
# the panel and the browser preview bit-for-bit identical (test/pixel-glyphs.test.ts).
SHARED    ?= ../..
# Extra source trees and include roots an app can pull in. tc002-os compiles the
# arcade's seven game engines unchanged rather than porting them: they are
# hardware-verified and already covered by the arcade's own self-check, so a
# port would fork that guarantee. EXTRA_INC comes AFTER $(APP)/src so the app's
# own headers still win (tc002-os provides utils/Surface.h as a bridge).
EXTRA_SRC_DIRS ?=
EXTRA_INC ?=
# Extra dependency packages, opt-in per app. tc002-os adds `zknet` for exactly
# one function — NetUtils::dhcpRequestIp — because this device ships no DHCP
# client binary at all and that symbol is the same libnetutils code the stock
# firmware has used on this chip for years. It is NOT in DEP_INC because the
# other two firmwares have no business carrying a DT_NEEDED on libzknet.so.
#
# Only include/net/NetUtils.h is vendored from that package on purpose: it is
# pure statics with zero includes. NetManager.h/WifiManager.h/SoftApManager.h
# are deliberately absent, because those managers own the radio power path and
# call rmmod against module directories that DO NOT EXIST on this unit
# (/late/lib/modules, /config/lib/modules; the real ones are /lib/modules/4.9.84).
# One trip through that branch unloads aic8800_fdrv with no way back: wlan0
# vanishes, and adb — which rides that link — dies with it. hostcheck/link-audit.sh
# enforces their absence in the built .so.
EXTRA_PKGS ?=
EXTRA_LIBS ?=
ALL_PKGS := $(DEP_INC) $(EXTRA_PKGS)
INCLUDES := -I$(APP)/src $(foreach d,$(EXTRA_INC),-I$(d)) -I$(SHARED) $(foreach d,$(ALL_PKGS),-I$(PKG)/$(d)/include) -I$(BOOST_INC)

# Compile flags copied from .cproject (optimization "most" → -O3, C++11, -fPIC).
# Two globals the IDE injects (Manifest platform="Z21"), not in .cproject:
#   LOG_TAG        — the log framework references it unconditionally.
#   __PLATFORM_Z21__ — selects std::function (not boost) and the Z21 code paths
#                      in the dependency headers, matching how the .a libs were
#                      built. Omitting it flips base::function to boost and every
#                      symbol signature mismatches the device libraries.
PLATFORM ?= __PLATFORM_Z21__
CXXFLAGS := -c -fmessage-length=0 -pipe -Wformat -Werror=format-security \
            -fstack-protector -fno-caller-saves -fexceptions -fPIC \
            -std=gnu++11 -O3 -DLOG_TAG='"zkgui"' -D$(PLATFORM) $(INCLUDES)

# Link flags from .cproject, minus -z,defs: the app resolves framework symbols
# at load time, so undefined symbols are expected in a standalone link.
LDFLAGS := -shared -Wl,-z,now -Wl,-z,relro -Wl,--warn-common \
           -Wl,-z,combreloc -Wl,--warn-once
# device-audio/lib holds MI/media .so pulled from the device (libmi_ao etc.),
# resolving audio-utility's MI_AO_* symbols at load time.
LIBDIRS := $(foreach d,$(ALL_PKGS),-L$(PKG)/$(d)/lib) -L$(PKG)/device-audio/lib
# Wrap in a group: the static libs cross-reference each other, so the linker
# must scan them repeatedly (order-independent symbol resolution).
LIBS    := -Wl,--start-group -leasyui -lzkhardware -llog -lbase-utility -ltransfer-protocols \
           -laudio-utility -lbase-json \
           -lavformat -lavcodec -lavfilter -lavdevice -lswscale -lswresample -lavutil -lz \
           -lmi_ao -lmi_sys -lmi_common -lzkmedia $(EXTRA_LIBS) -Wl,--end-group

# FlyThings convention: logic/*.cc are not translation units — the IDE-generated
# activity/*.cpp #includes them. Compile only .cpp/.c and exclude logic/.
SRCS := $(shell find $(APP)/src \( -name '*.cpp' -o -name '*.c' \) -not -path '*/logic/*')
EXTRA_SRCS := $(if $(EXTRA_SRC_DIRS),$(shell find $(EXTRA_SRC_DIRS) -name '*.cpp'),)
# Strip the $(APP) prefix so objects land UNDER $(BUILD_DIR). The old
# 'build/%.o,$(SRCS)' yielded 'build/../app/...', whose build/.. escapes build/,
# dropping .o files into the source tree where `clean` (rm -rf build) never
# deleted them — stale objects then survived every rebuild.
# App objects mirror the source tree under $(BUILD_DIR); extra sources live
# outside $(APP) entirely, so they are flattened into build/extra/ by basename
# and resolved through vpath. Flattening is safe because the engine filenames
# are unique, and it keeps '..' out of the object paths — the same escape that
# once dropped .o files into the source tree.
OBJS := $(patsubst $(APP)/%,$(BUILD_DIR)/%.o,$(SRCS)) \
        $(addprefix $(BUILD_DIR)/extra/,$(addsuffix .o,$(notdir $(EXTRA_SRCS))))
vpath %.cpp $(EXTRA_SRC_DIRS)
# activity/*.cpp #include logic/*.cc; make cannot see that include, so make every
# object depend on all logic sources — otherwise editing a logic file leaves the
# activity object stale (its own mtime is unchanged) and the change never lands.
LOGIC := $(shell find $(APP)/src/logic -name '*.cc' 2>/dev/null)

# Relink when the source LIST changes, not merely when some source is newer.
#
# Deleting a file otherwise ships forever: the .so is still newer than every
# remaining prerequisite, so make does nothing and the removed translation unit
# stays linked in. That is invisible — the build says nothing, the size barely
# moves — and it is the same class of failure as deploying a build that had
# actually errored. The stamp is rewritten only when the sorted list differs, so
# it does not force a relink on every invocation.
SRCLIST := $(BUILD_DIR)/.srclist
$(shell mkdir -p $(BUILD_DIR) && printf '%s\n' $(sort $(SRCS) $(EXTRA_SRCS)) > $(SRCLIST).new && \
        (cmp -s $(SRCLIST).new $(SRCLIST) || mv $(SRCLIST).new $(SRCLIST)) && rm -f $(SRCLIST).new)

all: $(OUT)

$(BUILD_DIR)/%.o: $(APP)/% $(LOGIC)
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) $< -o $@

# Sources outside $(APP), found through vpath by basename.
$(BUILD_DIR)/extra/%.o: %
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) $< -o $@

# Strip before shipping: the device pushes this into /tmp (tmpfs = RAM) on a
# 36MB box; the unstripped ~6.7MB .so spikes RAM during `adb push` and OOM-reboots
# the device (wiping tmpfs). Stripped it is ~1.8MB. mmap still resolves the
# framework symbols at load, so the app is unchanged.
$(OUT): $(OBJS) $(SRCLIST)
	$(CXX) $(LDFLAGS) $(LIBDIRS) -o $@ $(OBJS) $(LIBS)
	$(TOOLCHAIN)/bin/arm-linux-gnueabihf-strip --strip-unneeded $@
	@echo "=== built $(OUT) ==="
	@$(TOOLCHAIN)/bin/arm-linux-gnueabihf-readelf -h $@ | grep -E 'Class|Machine|Type'

clean:
	rm -rf $(BUILD_DIR) $(OUT)

.PHONY: all clean

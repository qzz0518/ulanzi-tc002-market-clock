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
INCLUDES := -I$(APP)/src -I$(SHARED) $(foreach d,$(DEP_INC),-I$(PKG)/$(d)/include) -I$(BOOST_INC)

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
LIBDIRS := $(foreach d,$(DEP_INC),-L$(PKG)/$(d)/lib) -L$(PKG)/device-audio/lib
# Wrap in a group: the static libs cross-reference each other, so the linker
# must scan them repeatedly (order-independent symbol resolution).
LIBS    := -Wl,--start-group -leasyui -lzkhardware -llog -lbase-utility -ltransfer-protocols \
           -laudio-utility -lbase-json \
           -lavformat -lavcodec -lavfilter -lavdevice -lswscale -lswresample -lavutil -lz \
           -lmi_ao -lmi_sys -lmi_common -lzkmedia -Wl,--end-group

# FlyThings convention: logic/*.cc are not translation units — the IDE-generated
# activity/*.cpp #includes them. Compile only .cpp/.c and exclude logic/.
SRCS := $(shell find $(APP)/src \( -name '*.cpp' -o -name '*.c' \) -not -path '*/logic/*')
# Strip the $(APP) prefix so objects land UNDER $(BUILD_DIR). The old
# 'build/%.o,$(SRCS)' yielded 'build/../app/...', whose build/.. escapes build/,
# dropping .o files into the source tree where `clean` (rm -rf build) never
# deleted them — stale objects then survived every rebuild.
OBJS := $(patsubst $(APP)/%,$(BUILD_DIR)/%.o,$(SRCS))
# activity/*.cpp #include logic/*.cc; make cannot see that include, so make every
# object depend on all logic sources — otherwise editing a logic file leaves the
# activity object stale (its own mtime is unchanged) and the change never lands.
LOGIC := $(shell find $(APP)/src/logic -name '*.cc' 2>/dev/null)

all: $(OUT)

$(BUILD_DIR)/%.o: $(APP)/% $(LOGIC)
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) $< -o $@

# Strip before shipping: the device pushes this into /tmp (tmpfs = RAM) on a
# 36MB box; the unstripped ~6.7MB .so spikes RAM during `adb push` and OOM-reboots
# the device (wiping tmpfs). Stripped it is ~1.8MB. mmap still resolves the
# framework symbols at load, so the app is unchanged.
$(OUT): $(OBJS)
	$(CXX) $(LDFLAGS) $(LIBDIRS) -o $@ $(OBJS) $(LIBS)
	$(TOOLCHAIN)/bin/arm-linux-gnueabihf-strip --strip-unneeded $@
	@echo "=== built $(OUT) ==="
	@$(TOOLCHAIN)/bin/arm-linux-gnueabihf-readelf -h $@ | grep -E 'Class|Machine|Type'

clean:
	rm -rf $(BUILD_DIR) $(OUT)

.PHONY: all clean

// squeak-fans: the Mac's temperatures and fans, for src/fleet/heat.ts.
//
//   squeak-fans read            one line of JSON: the hottest die sensor, every fan's speed and mode,
//                               and the built-in display's brightness. No root.
//   squeak-fans max|80|60|40    every fan to full, or that share of the way from its minimum to its
//                               maximum (root).
//   squeak-fans auto            every fan back to the system's control (root).
//   squeak-fans brightness N    the built-in display's brightness, 0–100. No root.
//
// It takes nothing else: no options, no files, no environment. That matters because
// the Mac app installs it root-owned in /Library/PrivilegedHelperTools and a sudoers
// rule lets the daemon run exactly the five fan commands without a password.
//
// Temperatures come from IOHIDEventSystemClient (what Stats and iStat Menus read),
// fans from the SMC: FNum, F<n>Ac/Mn/Mx, and F<n>md (0 system, 1 manual) with
// F<n>Tg as the target, the keys Macs Fan Control writes on Apple silicon.
#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <IOKit/IOKitLib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

typedef struct { char major, minor, build, reserved[1]; UInt16 release; } SMCVers;
typedef struct { UInt16 version, length; UInt32 cpuPLimit, gpuPLimit, memPLimit; } SMCPLimit;
typedef struct { UInt32 dataSize; UInt32 dataType; char dataAttributes; } SMCKeyInfo;
typedef struct {
    UInt32 key;
    SMCVers vers;
    SMCPLimit pLimitData;
    SMCKeyInfo keyInfo;
    char result, status, data8;
    UInt32 data32;
    unsigned char bytes[32];
} SMCParam;

enum { kSMCHandle = 2, kSMCRead = 5, kSMCWrite = 6, kSMCInfo = 9 };
static io_connect_t smc;

static UInt32 code(const char *s) { return (UInt32)s[0] << 24 | (UInt32)s[1] << 16 | (UInt32)s[2] << 8 | (UInt32)s[3]; }

static int call(SMCParam *in, SMCParam *out) {
    size_t size = sizeof(SMCParam);
    return IOConnectCallStructMethod(smc, kSMCHandle, in, sizeof(SMCParam), out, &size) == kIOReturnSuccess && out->result == 0 ? 0 : -1;
}

static int info(const char *key, SMCKeyInfo *keyInfo) {
    SMCParam in = {0}, out = {0};
    in.key = code(key);
    in.data8 = kSMCInfo;
    if (call(&in, &out)) return -1;
    *keyInfo = out.keyInfo;
    return 0;
}

static int readKey(const char *key, unsigned char bytes[32], SMCKeyInfo *keyInfo) {
    SMCParam in = {0}, out = {0};
    if (info(key, keyInfo)) return -1;
    in.key = code(key);
    in.keyInfo.dataSize = keyInfo->dataSize;
    in.data8 = kSMCRead;
    if (call(&in, &out)) return -1;
    memcpy(bytes, out.bytes, 32);
    return 0;
}

static int writeKey(const char *key, const void *bytes, UInt32 size) {
    SMCKeyInfo keyInfo;
    SMCParam in = {0}, out = {0};
    if (info(key, &keyInfo) || keyInfo.dataSize != size) return -1;
    in.key = code(key);
    in.data8 = kSMCWrite;
    in.keyInfo.dataSize = size;
    memcpy(in.bytes, bytes, size);
    return call(&in, &out);
}

/// A fan value: Apple silicon stores them as 4-byte floats ("flt "); older Macs as fpe2.
static double readFloat(const char *key) {
    unsigned char b[32];
    SMCKeyInfo ki;
    if (readKey(key, b, &ki)) return -1;
    if (ki.dataSize == 4 && ki.dataType == code("flt ")) { float f; memcpy(&f, b, 4); return f; }
    if (ki.dataSize == 2 && ki.dataType == code("fpe2")) return ((b[0] << 8) | b[1]) / 4.0;
    return -1;
}

static int fanCount(void) {
    unsigned char b[32];
    SMCKeyInfo ki;
    return readKey("FNum", b, &ki) ? 0 : b[0];
}

static int fanMode(int i) {
    char key[5];
    unsigned char b[32];
    SMCKeyInfo ki;
    snprintf(key, sizeof key, "F%dmd", i);
    if (readKey(key, b, &ki) == 0) return b[0];
    snprintf(key, sizeof key, "F%dMd", i);
    return readKey(key, b, &ki) == 0 ? b[0] : -1;
}

/// Sets fan i to manual at `target` rpm, or back to the system (target < 0).
static int setFan(int i, double target) {
    char key[5];
    unsigned char manual = target < 0 ? 0 : 1;
    snprintf(key, sizeof key, "F%dmd", i);
    if (writeKey(key, &manual, 1)) {
        snprintf(key, sizeof key, "F%dMd", i);
        if (writeKey(key, &manual, 1)) return -1;
    }
    if (target < 0) return 0;
    float f = (float)target;
    snprintf(key, sizeof key, "F%dTg", i);
    return writeKey(key, &f, 4);
}

// IOHIDEventSystemClient: private, but stable since 10.x and what every temperature tool uses.
typedef struct __IOHIDEventSystemClient *IOHIDEventSystemClientRef;
typedef struct __IOHIDServiceClient *IOHIDServiceClientRef;
typedef struct __IOHIDEvent *IOHIDEventRef;
extern IOHIDEventSystemClientRef IOHIDEventSystemClientCreate(CFAllocatorRef);
extern int IOHIDEventSystemClientSetMatching(IOHIDEventSystemClientRef, CFDictionaryRef);
extern CFArrayRef IOHIDEventSystemClientCopyServices(IOHIDEventSystemClientRef);
extern IOHIDEventRef IOHIDServiceClientCopyEvent(IOHIDServiceClientRef, int64_t, int32_t, int64_t);
extern CFTypeRef IOHIDServiceClientCopyProperty(IOHIDServiceClientRef, CFStringRef);
extern double IOHIDEventGetFloatValue(IOHIDEventRef, int32_t);
enum { kIOHIDEventTypeTemperature = 15 };

/// The hottest die sensor ("PMU tdie…" on Apple silicon), or -1. Sensors that read
/// nonsense (some "tdev" ones say −9201 °C) are skipped.
static double hottestDie(int *count) {
    double hottest = -1;
    *count = 0;
    IOHIDEventSystemClientRef client = IOHIDEventSystemClientCreate(kCFAllocatorDefault);
    if (!client) return -1;
    int page = 0xff00, usage = 5;
    CFNumberRef pageRef = CFNumberCreate(NULL, kCFNumberIntType, &page), usageRef = CFNumberCreate(NULL, kCFNumberIntType, &usage);
    const void *keys[] = {CFSTR("PrimaryUsagePage"), CFSTR("PrimaryUsage")};
    const void *values[] = {pageRef, usageRef};
    CFDictionaryRef match = CFDictionaryCreate(NULL, keys, values, 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    IOHIDEventSystemClientSetMatching(client, match);
    CFArrayRef services = IOHIDEventSystemClientCopyServices(client);
    for (CFIndex i = 0; services && i < CFArrayGetCount(services); i++) {
        IOHIDServiceClientRef service = (IOHIDServiceClientRef)CFArrayGetValueAtIndex(services, i);
        CFStringRef name = IOHIDServiceClientCopyProperty(service, CFSTR("Product"));
        char text[64] = "";
        if (name) { CFStringGetCString(name, text, sizeof text, kCFStringEncodingUTF8); CFRelease(name); }
        if (strstr(text, "tdie") == NULL) continue;
        IOHIDEventRef event = IOHIDServiceClientCopyEvent(service, kIOHIDEventTypeTemperature, 0, 0);
        if (!event) continue;
        double celsius = IOHIDEventGetFloatValue(event, kIOHIDEventTypeTemperature << 16);
        CFRelease(event);
        if (celsius <= 0 || celsius >= 150) continue;
        (*count)++;
        if (celsius > hottest) hottest = celsius;
    }
    if (services) CFRelease(services);
    CFRelease(match); CFRelease(pageRef); CFRelease(usageRef); CFRelease((CFTypeRef)client);
    return hottest;
}

// DisplayServices (private, what the brightness keys use): no root, and only the built-in panel.
typedef int (*BrightnessGet)(CGDirectDisplayID, float *);
typedef int (*BrightnessSet)(CGDirectDisplayID, float);
static void *displayServices(void) {
    static void *handle;
    if (!handle) handle = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_LAZY);
    return handle;
}

/// The built-in display while it is on, or 0 (lid closed, or a desktop).
static CGDirectDisplayID builtinDisplay(void) {
    CGDirectDisplayID displays[16];
    uint32_t count = 0;
    if (CGGetOnlineDisplayList(16, displays, &count) != kCGErrorSuccess) return 0;
    for (uint32_t i = 0; i < count; i++) if (CGDisplayIsBuiltin(displays[i]) && CGDisplayIsActive(displays[i])) return displays[i];
    return 0;
}

static int getBrightness(void) {
    CGDirectDisplayID display = builtinDisplay();
    BrightnessGet get = displayServices() ? (BrightnessGet)dlsym(displayServices(), "DisplayServicesGetBrightness") : NULL;
    float value;
    if (!display || !get || get(display, &value) != 0) return -1;
    return (int)(value * 100 + 0.5);
}

static int setBrightness(int percent) {
    CGDirectDisplayID display = builtinDisplay();
    BrightnessSet set = displayServices() ? (BrightnessSet)dlsym(displayServices(), "DisplayServicesSetBrightness") : NULL;
    if (!display || !set) return -1;
    return set(display, percent / 100.0f) == 0 ? 0 : -1;
}

/// "max", "80", "60", "40" as a share of the range; -1 for anything else.
static double fanShare(const char *mode) {
    if (strcmp(mode, "max") == 0) return 1.0;
    if (strcmp(mode, "80") == 0) return 0.8;
    if (strcmp(mode, "60") == 0) return 0.6;
    if (strcmp(mode, "40") == 0) return 0.4;
    return -1;
}

static int openSmc(void) {
    io_service_t service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"));
    if (!service) return -1;
    kern_return_t result = IOServiceOpen(service, mach_task_self(), 0, &smc);
    IOObjectRelease(service);
    return result == kIOReturnSuccess ? 0 : -1;
}

int main(int argc, char **argv) {
    const char *usage = "usage: squeak-fans read|auto|max|80|60|40|brightness <0-100>\n";
    if (argc == 3 && strcmp(argv[1], "brightness") == 0) {
        char *end;
        long percent = strtol(argv[2], &end, 10);
        if (*argv[2] == '\0' || *end != '\0' || percent < 0 || percent > 100) { fputs(usage, stderr); return 64; }
        if (setBrightness((int)percent)) { fprintf(stderr, "no built-in display to set\n"); return 69; }
        return 0;
    }
    if (argc != 2) { fputs(usage, stderr); return 64; }
    const char *mode = argv[1];
    int smcOpen = openSmc() == 0;
    int fans = smcOpen ? fanCount() : 0;
    if (strcmp(mode, "read") == 0) {
        int sensors;
        double die = hottestDie(&sensors);
        printf("{\"die\":");
        if (die < 0) printf("null"); else printf("%.1f", die);
        printf(",\"sensors\":%d,\"fans\":[", sensors);
        for (int i = 0; i < fans; i++) {
            char ac[5], mn[5], mx[5];
            snprintf(ac, sizeof ac, "F%dAc", i); snprintf(mn, sizeof mn, "F%dMn", i); snprintf(mx, sizeof mx, "F%dMx", i);
            printf("%s{\"rpm\":%.0f,\"min\":%.0f,\"max\":%.0f,\"manual\":%s}", i ? "," : "", readFloat(ac), readFloat(mn),
                   readFloat(mx), fanMode(i) == 1 ? "true" : "false");
        }
        int brightness = getBrightness();
        printf("],\"brightness\":");
        if (brightness < 0) printf("null"); else printf("%d", brightness);
        printf("}\n");
        return 0;
    }
    double share = fanShare(mode);
    if (share < 0 && strcmp(mode, "auto") != 0) { fputs(usage, stderr); return 64; }
    if (geteuid() != 0) { fprintf(stderr, "squeak-fans %s needs root\n", mode); return 77; }
    if (!smcOpen || fans == 0) { fprintf(stderr, "no fans\n"); return 69; }
    int failed = 0;
    for (int i = 0; i < fans; i++) {
        char mn[5], mx[5];
        snprintf(mn, sizeof mn, "F%dMn", i);
        snprintf(mx, sizeof mx, "F%dMx", i);
        double min = readFloat(mn), max = readFloat(mx);
        if (max <= 0) max = 6000;
        if (min < 0 || min > max) min = 0;
        if (setFan(i, share < 0 ? -1 : min + (max - min) * share)) failed++;
    }
    if (failed) { fprintf(stderr, "%d of %d fans refused\n", failed, fans); return 70; }
    return 0;
}

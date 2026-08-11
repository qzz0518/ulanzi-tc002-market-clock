#include "entry/EasyUIContext.h"
#include "uart/UartContext.h"

#ifdef __cplusplus
extern "C" {
#endif

void onEasyUIInit(EasyUIContext *pContext) {
}

void onEasyUIDeinit(EasyUIContext *pContext) {
	UARTCONTEXT->closeUart();
}

const char* onStartupApp(EasyUIContext *pContext) {
	return "osActivity";
}

#ifdef __cplusplus
}
#endif

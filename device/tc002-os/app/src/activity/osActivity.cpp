#include "osActivity.h"

static osActivity* mActivityPtr;

/*register activity*/
REGISTER_ACTIVITY(osActivity);

typedef struct {
	int id;    // timer id, must be unique
	int time;  // interval in milliseconds
} S_ACTIVITY_TIMEER;

#include "logic/osLogic.cc"

osActivity::osActivity() {
}

osActivity::~osActivity() {
	unregisterProtocolDataUpdateListener(onProtocolDataUpdate);
	onUI_quit();
	mActivityPtr = NULL;
}

const char* osActivity::getAppName() const {
	return "os.ftu";
}

void osActivity::onCreate() {
	Activity::onCreate();
	mActivityPtr = this;
	onUI_init();
	registerProtocolDataUpdateListener(onProtocolDataUpdate);
	registerActivityTimers();
}

void osActivity::onResume() {
	Activity::onResume();
	onUI_show();
}

void osActivity::onPause() {
	Activity::onPause();
	onUI_hide();
}

void osActivity::onIntent(const Intent *intentPtr) {
	Activity::onIntent(intentPtr);
	onUI_intent(intentPtr);
}

bool osActivity::onTimer(int id) {
	return onUI_Timer(id);
}

void osActivity::registerActivityTimers() {
	int tablen = sizeof(REGISTER_ACTIVITY_TIMER_TAB) / sizeof(S_ACTIVITY_TIMEER);
	for (int i = 0; i < tablen; ++i) {
		S_ACTIVITY_TIMEER temp = REGISTER_ACTIVITY_TIMER_TAB[i];
		registerTimer(temp.id, temp.time);
	}
}

void osActivity::registerUserTimer(int id, int time) {
	registerTimer(id, time);
}

void osActivity::unregisterUserTimer(int id) {
	unregisterTimer(id);
}

void osActivity::resetUserTimer(int id, int time) {
	resetTimer(id, time);
}

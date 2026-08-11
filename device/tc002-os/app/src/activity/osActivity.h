#ifndef __OSACTIVITY_H__
#define __OSACTIVITY_H__

#include "app/Activity.h"
#include "entry/EasyUIContext.h"

#include "uart/ProtocolData.h"
#include "uart/ProtocolParser.h"

#include "utils/Log.h"

/**
 * The FlyThings activity shell for tc002-os.
 *
 * Deliberately much smaller than the IDE-generated template the arcade firmware
 * carries: this firmware paints the LED matrix directly through Presenter and
 * uses no ZK widgets at all, so the list/seek/slide/video/edit listener tables
 * are not just empty — they cannot ever be used. Everything real lives in
 * logic/osLogic.cc, which this translation unit includes.
 */
class osActivity : public Activity {
public:
	osActivity();
	virtual ~osActivity();

	// Timer plumbing used by the render loop in osLogic.cc.
	void registerUserTimer(int id, int time);
	void unregisterUserTimer(int id);
	void resetUserTimer(int id, int time);

protected:
	virtual const char* getAppName() const;
	virtual void onCreate();
	virtual void onResume();
	virtual void onPause();
	virtual void onIntent(const Intent *intentPtr);
	virtual bool onTimer(int id);

private:
	void registerActivityTimers();
};

#endif /* __OSACTIVITY_H__ */

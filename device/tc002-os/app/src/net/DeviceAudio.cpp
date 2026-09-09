#include "net/DeviceAudio.h"

#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

namespace tcos {

namespace {

const char* const kTrackPath = "/tmp/track.mp3";
const char* const kPartPath = "/tmp/track.mp3.part";

uint64_t monoMs() {
  struct timespec ts;
  ::clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<uint64_t>(ts.tv_sec) * 1000u + static_cast<uint64_t>(ts.tv_nsec / 1000000);
}

// Track ids are digits (NetEase) or base62 (Spotify); this is for the day one
// is not, so a stray quote cannot turn a heartbeat into a parse error the
// service answers with 400 forever.
std::string jsonString(const std::string& raw) {
  std::string out;
  out.reserve(raw.size() + 2);
  out += '"';
  for (size_t i = 0; i < raw.size(); ++i) {
    const char c = raw[i];
    if (c == '"' || c == '\\') out += '\\';
    if (static_cast<unsigned char>(c) < 0x20) continue;
    out += c;
  }
  out += '"';
  return out;
}

}  // namespace

const char* DeviceAudioLink::trackPath() { return kTrackPath; }
const char* DeviceAudioLink::partPath() { return kPartPath; }

// ---- pure ------------------------------------------------------------------

std::string DeviceAudioLink::field(const std::string& body, const char* key) {
  const std::string needle = std::string(key) + "\t";
  std::string::size_type at = 0;
  while (at <= body.size()) {
    const std::string::size_type eol = body.find('\n', at);
    const std::string line = body.substr(at, eol == std::string::npos ? std::string::npos : eol - at);
    if (line.compare(0, needle.size(), needle) == 0) {
      std::string value = line.substr(needle.size());
      while (!value.empty() && (value[value.size() - 1] == '\r' || value[value.size() - 1] == ' ')) {
        value.erase(value.size() - 1);
      }
      return value;
    }
    if (eol == std::string::npos) break;
    at = eol + 1;
  }
  return std::string();
}

bool DeviceAudioLink::parseState(const std::string& body, DeviceMusicState* out) {
  const std::string seq = field(body, "SEQ");
  if (seq.empty()) return false;
  DeviceMusicState state;
  state.seq = ::atoi(seq.c_str());
  state.remote = field(body, "RMT") == "1";
  const std::string tid = field(body, "TID");
  state.trackId = tid == "-" ? std::string() : tid;
  state.play = field(body, "PLAY") == "1";
  const std::string seek = field(body, "SEEK");
  state.seekMs = seek.empty() ? -1 : ::atoi(seek.c_str());
  if (state.seekMs < 0) state.seekMs = -1;
  *out = state;
  return true;
}

std::string DeviceAudioLink::heartbeatBody(const std::string& trackId, int playheadMs, bool playing) {
  char tail[64];
  ::snprintf(tail, sizeof(tail), ",\"playheadMs\":%d,\"playing\":%s}",
             playheadMs < 0 ? 0 : playheadMs, playing ? "true" : "false");
  return "{\"trackId\":" + jsonString(trackId) + tail;
}

std::string DeviceAudioLink::playingReportBody(bool playing) {
  return playing ? "{\"playing\":true}" : "{\"playing\":false}";
}

// ---- lifecycle --------------------------------------------------------------

DeviceAudioLink::DeviceAudioLink()
    : mSink(0), mRunning(false), mThreadStarted(false),
      mSeq(-1), mRemote(false), mLoaded(false), mPlaying(false),
      mAnchorMs(0), mAnchorAtMs(0), mSeekApplied(-1), mRetryAtMs(0),
      mFile(0), mReceived(0) {
  ::pthread_mutex_init(&mLock, 0);
  ::pthread_mutex_init(&mSinkLock, 0);
}

DeviceAudioLink::~DeviceAudioLink() {
  stop();
  ::pthread_mutex_destroy(&mSinkLock);
  ::pthread_mutex_destroy(&mLock);
}

void DeviceAudioLink::setSink(AudioSink* sink) { mSink = sink; }

void DeviceAudioLink::start(const std::string& baseUrl) {
  if (mThreadStarted) return;
  mBaseUrl = baseUrl;
  while (!mBaseUrl.empty() && mBaseUrl[mBaseUrl.size() - 1] == '/') {
    mBaseUrl.erase(mBaseUrl.size() - 1);
  }
  if (mBaseUrl.empty()) return;
  // A file left by a previous session (this firmware's or the sideloaded
  // player's) is tmpfs the next download would have to fit beside.
  dropFile();
  mRunning = true;
  mThreadStarted = true;
  ::pthread_create(&mThread, 0, &DeviceAudioLink::workerMain, this);
}

void DeviceAudioLink::stop() {
  if (!mThreadStarted) return;
  mRunning = false;
  // The longest wait is one download's read timeout, once, at shutdown.
  ::pthread_join(mThread, 0);
  mThreadStarted = false;

  ::pthread_mutex_lock(&mSinkLock);
  if (mSink != 0) mSink->stop();
  ::pthread_mutex_unlock(&mSinkLock);
  dropFile();

  ::pthread_mutex_lock(&mLock);
  mSeq = -1;
  mRemote = false;
  mTrackId.clear();
  mLoaded = false;
  mPlaying = false;
  mAnchorMs = 0;
  mAnchorAtMs = 0;
  mSeekApplied = -1;
  mRetryAtMs = 0;
  mReports.clear();
  ::pthread_mutex_unlock(&mLock);
}

// ---- state --------------------------------------------------------------------

void DeviceAudioLink::anchor(int positionMs, uint64_t nowMs) {
  mAnchorMs = positionMs < 0 ? 0 : positionMs;
  mAnchorAtMs = nowMs;
}

bool DeviceAudioLink::hasTrack() const {
  ::pthread_mutex_lock(&mLock);
  const bool value = mLoaded;
  ::pthread_mutex_unlock(&mLock);
  return value;
}

bool DeviceAudioLink::playing() const {
  ::pthread_mutex_lock(&mLock);
  const bool value = mLoaded && mPlaying;
  ::pthread_mutex_unlock(&mLock);
  return value;
}

int DeviceAudioLink::playheadMs(uint64_t nowMs) const {
  ::pthread_mutex_lock(&mLock);
  int value = mAnchorMs;
  if (mLoaded && mPlaying && nowMs > mAnchorAtMs) {
    value += static_cast<int>(nowMs - mAnchorAtMs);
  }
  ::pthread_mutex_unlock(&mLock);
  return value;
}

bool DeviceAudioLink::wantsHeartbeat() const {
  ::pthread_mutex_lock(&mLock);
  const bool value = mLoaded && !mRemote && !mTrackId.empty();
  ::pthread_mutex_unlock(&mLock);
  return value;
}

DeviceAudioLink::Plan DeviceAudioLink::applyState(const DeviceMusicState& state, uint64_t nowMs) {
  Plan plan;
  ::pthread_mutex_lock(&mLock);
  const bool seqMoved = state.seq != mSeq;
  mSeq = state.seq;

  if (state.remote) {
    // The Connect player owns the audio. Nothing to download, and nothing to
    // say: a heartbeat here would tell the console the clock is playing a
    // track it cannot even fetch.
    if (!mTrackId.empty() || mLoaded) plan.stop = true;
    mRemote = true;
    mTrackId.clear();
    mLoaded = false;
    mPlaying = false;
    mRetryAtMs = 0;
    ::pthread_mutex_unlock(&mLock);
    return plan;
  }
  mRemote = false;

  if (state.trackId.empty()) {
    if (!mTrackId.empty() || mLoaded) plan.stop = true;
    mTrackId.clear();
    mLoaded = false;
    mPlaying = false;
    mRetryAtMs = 0;
    ::pthread_mutex_unlock(&mLock);
    return plan;
  }

  if (state.trackId != mTrackId) {
    // A new selection. The transport state travels with it and is applied
    // once the bytes are here (noteTrackLoaded); a pending seek from the
    // previous track means nothing for this one.
    mTrackId = state.trackId;
    mLoaded = false;
    mPlaying = state.play;
    mSeekApplied = -1;
    mRetryAtMs = 0;
    anchor(0, nowMs);
    plan.fetch = true;
    plan.trackId = mTrackId;
    ::pthread_mutex_unlock(&mLock);
    return plan;
  }

  if (!mLoaded) {
    // Still fetching, or the last fetch failed. The console's transport moves
    // meanwhile, so it is tracked here and applied on load.
    mPlaying = state.play;
    if (mRetryAtMs != 0 && nowMs >= mRetryAtMs) {
      mRetryAtMs = 0;
      plan.fetch = true;
      plan.trackId = mTrackId;
    }
    ::pthread_mutex_unlock(&mLock);
    return plan;
  }

  if (seqMoved) {
    // Only when the sequence moved: the same document seen twice must not seek
    // twice, and a seek is compared by value because the console nudges a
    // repeat by 1 ms for exactly that reason.
    if (state.seekMs >= 0 && state.seekMs != mSeekApplied) {
      mSeekApplied = state.seekMs;
      plan.seekMs = state.seekMs;
      anchor(state.seekMs, nowMs);
    }
    if (state.play != mPlaying) {
      // Re-anchor at the current playhead so a pause freezes the clock where
      // it is and a resume continues from there.
      anchor(mAnchorMs + (mPlaying && nowMs > mAnchorAtMs ? static_cast<int>(nowMs - mAnchorAtMs) : 0),
             nowMs);
      mPlaying = state.play;
      plan.setPlaying = state.play ? 1 : 0;
    }
  }
  ::pthread_mutex_unlock(&mLock);
  return plan;
}

DeviceAudioLink::Plan DeviceAudioLink::noteTrackLoaded(const std::string& trackId, bool ok,
                                                       uint64_t nowMs) {
  Plan plan;
  ::pthread_mutex_lock(&mLock);
  if (mRemote || mTrackId.empty()) {
    // The source changed under the download. The file is useless; the worker
    // drops it with the stop.
    plan.stop = true;
  } else if (trackId != mTrackId) {
    // The selection moved on while these bytes were arriving. Fetch what is
    // wanted now rather than waiting for the next poll to notice.
    plan.fetch = true;
    plan.trackId = mTrackId;
  } else if (!ok) {
    mLoaded = false;
    mRetryAtMs = nowMs + kRetryMs;
  } else {
    mLoaded = true;
    mSeekApplied = -1;
    anchor(0, nowMs);
    plan.play = true;
    // The console may have paused while the download was in flight; a fresh
    // decoder starts playing, so it is told to hold.
    if (!mPlaying) plan.setPlaying = 0;
  }
  ::pthread_mutex_unlock(&mLock);
  return plan;
}

void DeviceAudioLink::noteCompleted(uint64_t nowMs) {
  ::pthread_mutex_lock(&mLock);
  if (mLoaded && mPlaying) {
    anchor(mAnchorMs + (nowMs > mAnchorAtMs ? static_cast<int>(nowMs - mAnchorAtMs) : 0), nowMs);
    mPlaying = false;
  }
  ::pthread_mutex_unlock(&mLock);
}

void DeviceAudioLink::togglePlay(uint64_t nowMs) {
  ::pthread_mutex_lock(&mLock);
  if (!mLoaded) {
    ::pthread_mutex_unlock(&mLock);
    return;
  }
  anchor(mAnchorMs + (mPlaying && nowMs > mAnchorAtMs ? static_cast<int>(nowMs - mAnchorAtMs) : 0),
         nowMs);
  mPlaying = !mPlaying;
  const bool playing = mPlaying;
  // Two is a double press; the newest state is the one that matters, and the
  // service applies them in order anyway.
  if (mReports.size() >= 2) mReports.erase(mReports.begin());
  mReports.push_back(playingReportBody(playing));
  ::pthread_mutex_unlock(&mLock);

  ::pthread_mutex_lock(&mSinkLock);
  if (mSink != 0) {
    if (playing) mSink->resume();
    else mSink->pause();
  }
  ::pthread_mutex_unlock(&mSinkLock);
}

// ---- worker ----------------------------------------------------------------------

void* DeviceAudioLink::workerMain(void* self) {
  static_cast<DeviceAudioLink*>(self)->runWorker();
  return 0;
}

void DeviceAudioLink::runWorker() {
  while (mRunning) {
    // Reports first: a press must not queue behind a two-second sleep.
    std::vector<std::string> reports;
    ::pthread_mutex_lock(&mLock);
    reports.swap(mReports);
    ::pthread_mutex_unlock(&mLock);
    for (size_t i = 0; i < reports.size() && mRunning; ++i) {
      HttpClient::Response response;
      HttpClient::perform(mBaseUrl + "/api/music/device/report", "POST", "application/json",
                          reports[i], &response, 5000);
    }
    if (!mRunning) break;

    HttpClient::Response response;
    if (HttpClient::get(mBaseUrl + "/api/music/device/state?viewer=zos", &response, 5000) &&
        response.ok()) {
      DeviceMusicState state;
      if (parseState(response.body, &state)) {
        const uint64_t now = monoMs();
        execute(applyState(state, now), now);
      }
    }
    if (!mRunning) break;

    if (wantsHeartbeat()) {
      const uint64_t now = monoMs();
      ::pthread_mutex_lock(&mLock);
      const std::string trackId = mTrackId;
      ::pthread_mutex_unlock(&mLock);
      HttpClient::Response hb;
      HttpClient::perform(mBaseUrl + "/api/music/device/heartbeat", "POST", "application/json",
                          heartbeatBody(trackId, playheadMs(now), playing()), &hb, 5000);
    }

    // Sleep in slices so a press (a queued report) and a stop are both
    // answered within a tenth of a second rather than at the next poll.
    for (int slept = 0; slept < kPollMs && mRunning; slept += 100) {
      ::pthread_mutex_lock(&mLock);
      const bool pending = !mReports.empty();
      ::pthread_mutex_unlock(&mLock);
      if (pending) break;
      ::usleep(100 * 1000);
    }
  }
}

void DeviceAudioLink::execute(const Plan& first, uint64_t nowMs) {
  Plan plan = first;
  // A fetch can beget one more fetch (the selection moved on mid-download);
  // two is the bound because the worker re-reads the document in two seconds
  // anyway, and an unbounded chain here is a knob spun faster than the LAN.
  for (int round = 0; round < 2 && !plan.empty() && mRunning; ++round) {
    if (plan.stop) {
      ::pthread_mutex_lock(&mSinkLock);
      if (mSink != 0) mSink->stop();
      ::pthread_mutex_unlock(&mSinkLock);
      dropFile();
    }
    if (plan.play) {
      bool started = false;
      ::pthread_mutex_lock(&mSinkLock);
      if (mSink != 0) {
        started = mSink->play(kTrackPath);
        if (started && plan.setPlaying == 0) mSink->pause();
      }
      ::pthread_mutex_unlock(&mSinkLock);
      if (!started) {
        // The decoder refused the file: the same retry path as a failed
        // download, so the console sees a device that is not playing rather
        // than one that claims to be.
        ::pthread_mutex_lock(&mLock);
        mLoaded = false;
        mRetryAtMs = monoMs() + kRetryMs;
        ::pthread_mutex_unlock(&mLock);
      }
      plan.setPlaying = -1;
    }
    if (plan.seekMs >= 0 || plan.setPlaying >= 0) {
      ::pthread_mutex_lock(&mSinkLock);
      if (mSink != 0) {
        if (plan.seekMs >= 0) mSink->seek(plan.seekMs);
        if (plan.setPlaying == 1) mSink->resume();
        if (plan.setPlaying == 0) mSink->pause();
      }
      ::pthread_mutex_unlock(&mSinkLock);
    }
    if (!plan.fetch) break;
    const std::string wanted = plan.trackId;
    const bool ok = download();
    plan = noteTrackLoaded(wanted, ok, monoMs());
  }
  (void)nowMs;
}

// ---- download ---------------------------------------------------------------------

bool DeviceAudioLink::onReady(void* ctx, const HttpClient::Response& head, long declared) {
  DeviceAudioLink* self = static_cast<DeviceAudioLink*>(ctx);
  // Only a 200 is a track: the service answers 204 in remote mode, and an error
  // page is not something to hand a decoder. A declared length is not required
  // — the proxy may close-delimit — but a declared length past the cap is
  // refused before a byte lands in tmpfs.
  if (head.status != 200) return false;
  if (declared > kMaxTrackBytes) return false;
  self->mReceived = 0;
  self->mFile = ::fopen(kPartPath, "wb");
  return self->mFile != 0;
}

bool DeviceAudioLink::onData(void* ctx, const char* bytes, size_t count) {
  DeviceAudioLink* self = static_cast<DeviceAudioLink*>(ctx);
  if (self->mFile == 0) return false;
  if (self->mReceived + static_cast<long>(count) > kMaxTrackBytes) return false;
  if (::fwrite(bytes, 1, count, self->mFile) != count) return false;
  self->mReceived += static_cast<long>(count);
  return true;
}

bool DeviceAudioLink::download() {
  // Any previous track goes first: the two together may not fit in tmpfs.
  ::pthread_mutex_lock(&mSinkLock);
  if (mSink != 0) mSink->stop();
  ::pthread_mutex_unlock(&mSinkLock);
  dropFile();

  HttpClient::Stream sink;
  sink.ready = &DeviceAudioLink::onReady;
  sink.data = &DeviceAudioLink::onData;
  sink.ctx = this;
  HttpClient::Response head;
  // Per-read budget, not total: a slow proxy is still a proxy, and a total
  // budget large enough for a long track is one that hides a dead peer.
  const bool ok = HttpClient::streamGet(mBaseUrl + "/api/music/device/audio", &head, sink, 20000);
  if (mFile != 0) {
    ::fflush(mFile);
    ::fclose(mFile);
    mFile = 0;
  }
  if (!ok || mReceived <= 0) {
    ::unlink(kPartPath);
    return false;
  }
  if (::rename(kPartPath, kTrackPath) != 0) {
    ::unlink(kPartPath);
    return false;
  }
  return true;
}

void DeviceAudioLink::dropFile() {
  ::unlink(kTrackPath);
  ::unlink(kPartPath);
}

}  // namespace tcos

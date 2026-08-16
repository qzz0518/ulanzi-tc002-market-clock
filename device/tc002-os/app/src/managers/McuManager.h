#ifndef MANAGERS_MCUMANAGER_H_
#define MANAGERS_MCUMANAGER_H_

#include <mcuProtocol/mcuProtoParse.h>
#include <string>
#include <utility>
#include <mutex>

class McuManager {
public:
    static McuManager& getInstance() {
        static McuManager instance;
        return instance;
    }

    McuManager(const McuManager&) = delete;
    McuManager& operator=(const McuManager&) = delete;

    /**
     * @brief 初始�?MCU 实例
     * @param mcu MCU 通信实例指针
     */
    void initialize(PixelMcuProto::McuParse* mcu);

    /**
     * @brief 检查是否已初始�?
     */
    bool isInitialized() const { return mMcu != nullptr; }


    void setMicValue(int value);
    /**
     * @brief 查询麦克风�?
     * @return 麦克风�?
     */
    int queryMicValue();

    void setUsbState(int state);
    /**
     * @brief 查询 USB 连接状�?
     * @return USB 状�?
     */
    int queryUsbState();

    void setBatteryState(const std::pair<int, int>& state);
    /**
     * @brief Battery percentage and CELL VOLTAGE.
     *
     * The vendor's own comment here said `.second` was a charge flag
     * ("0-100, 0=not charging, 1=charging"). IT IS NOT. mcuProtoParse
     * assembles it as `(data[1] << 8) | data[2]` and the stock app logs the
     * same field as "V:%dmv" — it is the cell voltage in millivolts, and a
     * live battery therefore always reads well above zero. Believing the
     * comment is how ZOS came to report 充电中 on a clock that was never
     * plugged in, for the whole life of the firmware. Charging is
     * queryUsbState() and nothing else; the voltage is what the shutdown
     * protection runs on (platform/BatteryPolicy.h).
     *
     * @return pair<percent 0..100, millivolts>, or {-1,-1} when the query failed
     */
    std::pair<int, int> queryBatteryPower();

    /**
     * @brief 设置Mic是否自动上报
     */
    void setAutoMicReport(bool sw);
    /**
     * @brief 关机
     */
    void powerOff();

    /**
     * @brief 查询 MCU 版本
     * @param mcuVer 输出参数，MCU 版本字符�?
     * @return 0=成功, 其他=失败
     */
    int queryMcuVersion(std::string& mcuVer);

private:
    McuManager() : mMcu(nullptr), mMicValue(-1), mUsbState(-1), mBatterState({-1, -1}) {}
    ~McuManager() {}

    PixelMcuProto::McuParse* mMcu;
    int mMicValue;
    int mUsbState;
    std::pair<int, int> mBatterState;

    mutable std::mutex mMutex;
};

#endif

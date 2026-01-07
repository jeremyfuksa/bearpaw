import { AudioCategory } from './AudioCategory';
import { DisplayCategory } from './DisplayCategory';
import { PowerKeysCategory } from './PowerKeysCategory';
import { PriorityWeatherCategory } from './PriorityWeatherCategory';
import { SearchCategory } from './SearchCategory';

interface DeviceConfigCategoryProps {
  // Audio
  volumeLevel: number;
  squelchLevel: number;
  onVolumeChange: (value: number) => void;
  onSquelchChange: (value: number) => void;
  onVolumeCommit: (value: number) => void;
  onSquelchCommit: (value: number) => void;

  // Display
  backlight: string;
  contrast: number;
  onBacklightChange: (value: string) => void;
  onContrastChange: (value: number) => void;
  onContrastCommit: (value: number) => void;

  // Power & Keys
  keyBeepLevel: number;
  keyLock: boolean;
  batteryChargeTime: number;
  onKeyBeepChange: (value: number) => void;
  onKeyLockChange: (value: boolean) => void;
  onBatteryChargeChange: (value: number) => void;
  onBatteryChargeCommit: (value: number) => void;

  // Priority & Weather
  priorityMode: number;
  weatherPriority: boolean;
  onPriorityChange: (value: number) => void;
  onWeatherPriorityChange: (value: boolean) => void;

  // Search
  searchDelay: number;
  searchCode: boolean;
  onSearchDelayChange: (value: number) => void;
  onSearchCodeChange: (value: boolean) => void;

  connected: boolean;
}

export function DeviceConfigCategory(props: DeviceConfigCategoryProps) {
  const { connected } = props;

  return (
    <div className="device-config-container">
      <AudioCategory
        volumeLevel={props.volumeLevel}
        squelchLevel={props.squelchLevel}
        connected={connected}
        onVolumeChange={props.onVolumeChange}
        onSquelchChange={props.onSquelchChange}
        onVolumeCommit={props.onVolumeCommit}
        onSquelchCommit={props.onSquelchCommit}
      />

      <DisplayCategory
        backlight={props.backlight}
        contrast={props.contrast}
        connected={connected}
        onBacklightChange={props.onBacklightChange}
        onContrastChange={props.onContrastChange}
        onContrastCommit={props.onContrastCommit}
      />

      <PowerKeysCategory
        keyBeepLevel={props.keyBeepLevel}
        keyLock={props.keyLock}
        batteryChargeTime={props.batteryChargeTime}
        connected={connected}
        onKeyBeepChange={props.onKeyBeepChange}
        onKeyLockChange={props.onKeyLockChange}
        onBatteryChargeChange={props.onBatteryChargeChange}
        onBatteryChargeCommit={props.onBatteryChargeCommit}
      />

      <PriorityWeatherCategory
        priorityMode={props.priorityMode}
        weatherPriority={props.weatherPriority}
        connected={connected}
        onPriorityChange={props.onPriorityChange}
        onWeatherPriorityChange={props.onWeatherPriorityChange}
      />

      <SearchCategory
        searchDelay={props.searchDelay}
        searchCode={props.searchCode}
        connected={connected}
        onSearchDelayChange={props.onSearchDelayChange}
        onSearchCodeChange={props.onSearchCodeChange}
      />
    </div>
  );
}

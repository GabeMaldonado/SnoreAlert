import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View, SafeAreaView, NativeModules, Alert, ScrollView, Dimensions, AppState, TouchableOpacity, Switch, Modal } from 'react-native';
import { Audio } from 'expo-av';
import Svg, { Path, Line, Defs, LinearGradient, Stop } from 'react-native-svg';
import { useState, useEffect, useRef } from 'react';
import { SnoreDetector } from './SnoreDetector';
import * as Haptics from 'expo-haptics';
import { LineChart } from 'react-native-chart-kit';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as FileSystem from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  initConnection,
  endConnection,
  purchaseUpdatedListener,
  purchaseErrorListener,
  finishTransaction,
  getAvailablePurchases,
  fetchProducts,
  requestPurchase,
} from 'react-native-iap';

const { SleepSessionBridge, NotificationBridge, WatchConnectivityBridge } = NativeModules;
const LOG_DIR  = FileSystem.documentDirectory + 'SnoreGuardTrainingSessions/';
const LOG_FILE = LOG_DIR + 'snoreguard-log.txt';
const NOTIFICATION_COOLDOWN_MS = 10000; // 10 seconds between notifications
const LAST_SESSION_KEY = '@snoreguard:last_session';
const TRAINING_RECORDING_KEY = '@snoreguard:training_recording_enabled';

// In-memory log buffer — primary source for viewLogs. File write is best-effort backup.
// This survives render cycles but is cleared on app restart (file covers cross-session reads).
const inMemoryLogs = [];

// White noise machine baseline: -38 to -42 dB
// Room ambient without white noise: ~-55 dB
// Snoring typically falls in -35 to -48 dB range (RMS)
const SENSITIVITY_LEVELS = {
  High: -45,    // catches moderate/quiet snoring, well above -55 dB ambient
  Medium: -35,  // clearly audible snoring
  Low: -25      // only loud snoring
};

const SUBSCRIPTION_SKUS = {
  monthly: 'com.agenticdevlabs.snoreguard.monthly',
  annual:  'com.agenticdevlabs.snoreguard.annual',
};

// Gift codes — add/remove codes here and redeploy to update the list.
// Each code grants GIFT_CODE_DURATION_DAYS days of full access.
const GIFT_CODE_DURATION_DAYS = 30;
const GIFT_CODE_KEY = '@snoreguard:gift_code';
const GIFT_CODE_EXPIRES_KEY = '@snoreguard:gift_code_expires';
const GIFT_CODES = [
  'SNOREGUARD-PARTNER-2026',
  'SNOREGUARD-PRESS-2026',
  'SNOREGUARD-VIP-001',
  'SNOREGUARD-VIP-002',
  'SNOREGUARD-VIP-003',
];

// Configure notification handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true, // kept for SDK <52 compatibility
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const logEvent = async (message) => {
  const timestamp = new Date().toLocaleString();
  const logEntry = `${timestamp}: ${message}\n`;
  console.log(logEntry);
  inMemoryLogs.push(logEntry); // always available for viewLogs this session
};

// Write the complete in-memory session log to a timestamped file alongside the audio.
// Called once at session end so the file is always complete and never partially written.
const flushSessionLog = async (sessionStart) => {
  if (inMemoryLogs.length === 0) return;
  try {
    const d = sessionStart instanceof Date ? sessionStart : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const path = LOG_DIR + `snoreguard-log-${stamp}.txt`;
    await FileSystem.makeDirectoryAsync(LOG_DIR, { intermediates: true }).catch(() => {});
    await FileSystem.writeAsStringAsync(path, inMemoryLogs.join(''), {
      encoding: FileSystem.EncodingType.UTF8,
    });
    console.log(`Session log saved: ${path}`);
  } catch (e) {
    console.error('Failed to save session log:', e);
  }
};

// mlEventCount: real-time ML detections (may exceed dB threshold count when ML catches
// snoring at levels just below the raw dB threshold).
const calculateSnoreScore = (sessionData, threshold, mlEventCount = 0) => {
  if (!sessionData || sessionData.length === 0) return 0;

  const dbSnoreEvents = sessionData.filter(d => d.level > threshold);
  const effectiveEventCount = Math.max(dbSnoreEvents.length, mlEventCount);
  if (effectiveEventCount === 0) return 0;

  const snorePercentage = (effectiveEventCount / sessionData.length) * 100;

  // Average dB above threshold (positive = louder than threshold). Cap at 30 dB excess → 100%.
  const avgExcess = dbSnoreEvents.length > 0
    ? dbSnoreEvents.reduce((sum, d) => sum + (d.level - threshold), 0) / dbSnoreEvents.length
    : 5; // fallback: ML caught events just above the threshold
  const normalizedIntensity = Math.min(100, (avgExcess / 30) * 100);

  // Score 0-100 (lower is better): 70% frequency, 30% intensity above threshold
  return Math.min(100, Math.round(snorePercentage * 0.7 + normalizedIntensity * 0.3));
};

export default function App() {
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [lastSnoreLevel, setLastSnoreLevel] = useState(null);
  const [currentAudioLevel, setCurrentAudioLevel] = useState(null);
  const [sessionData, setSessionData] = useState([]);
  const [sessionStartTime, setSessionStartTime] = useState(null);
  const [sessionEndTime, setSessionEndTime] = useState(null);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [sensitivity, setSensitivity] = useState('Medium');
  const [snoreEventCount, setSnoreEventCount] = useState(0);
  const snoreDetectorRef = useRef(null);
  const isMonitoringRef = useRef(false);
  const sensitivityRef = useRef('Medium');
  const lastDataPointTimeRef = useRef(0);
  const lastLogTimeRef = useRef(0);
  const lastNotificationTimeRef = useRef(0);
  const snoreCountRef = useRef(0);
  const mlDetectionTimesRef = useRef([]);
  const logScrollViewRef = useRef(null);
  const logScrollAtBottomRef = useRef(true);
  const playbackSoundRef = useRef(null);
  const scrubberRef = useRef({ width: 0, isDragging: false });
  const appState = useRef(AppState.currentState);

  const [showLogsModal, setShowLogsModal] = useState(false);
  const [logContent, setLogContent] = useState('');
  const [activeAnalyticsTab, setActiveAnalyticsTab] = useState('stats');
  const [playbackStatus, setPlaybackStatus] = useState({ isPlaying: false, positionMs: 0, durationMs: 0 });
  const [recordingPath, setRecordingPath] = useState(null);
  const [waveformWidth, setWaveformWidth] = useState(Dimensions.get('window').width - 80);
  const [scrubProgress, setScrubProgress] = useState(-1);
  const [waveZoom, setWaveZoom] = useState(1.0);
  const [waveOffset, setWaveOffset] = useState(0.5); // center of visible window [0,1]
  const waveGestureRef = useRef({ pinchInitialDist: null, pinchInitialZoom: 1, panLastX: null, lastTapTime: 0 });

  // Notification settings state
  const [dailyReminderEnabled, setDailyReminderEnabled] = useState(true);
  const [reminderTime, setReminderTime] = useState('19:00'); // 7 PM default
  const [trainingRecordingEnabled, setTrainingRecordingEnabled] = useState(false);
  const [isInitialLoadComplete, setIsInitialLoadComplete] = useState(false);

  // Subscription / paywall state
  const [hasActiveSubscription, setHasActiveSubscription] = useState(false);
  const [isLoadingSubscription, setIsLoadingSubscription] = useState(true);
  const [showPaywall, setShowPaywall] = useState(false);
  const [subscriptionProducts, setSubscriptionProducts] = useState([]);
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [giftCodeActive, setGiftCodeActive] = useState(false);

  useEffect(() => {
    logEvent('App mounted');

    // Defined before the async IIFE so they can be called after sensitivity is loaded.
    const syncDataFromNative = async () => {
      if (SleepSessionBridge) {
        try {
          const nativeData = await SleepSessionBridge.getNativeData();
          // Skip recovery log if a session is actively running — this fires on every
          // foreground event and would log stale data from the previous session.
          if (nativeData && nativeData.length > 0 && !isMonitoringRef.current) {
            setSessionData(nativeData);

            const sessionStart = new Date(nativeData[0].time);
            const sessionEnd = new Date(nativeData[nativeData.length - 1].time);
            const levels = nativeData.map(d => d.level);
            const maxLevel = Math.max(...levels);
            const minLevel = Math.min(...levels);
            const activeSensitivity = sensitivityRef.current;
            const dbSnoreEvents = nativeData.filter(d => d.level > SENSITIVITY_LEVELS[activeSensitivity]);

            // Try to read the ML event count saved in AsyncStorage (only present if
            // stopMonitoring ran before iOS killed the app — otherwise 0).
            let mlEventCount = 0;
            try {
              const savedRaw = await AsyncStorage.getItem(LAST_SESSION_KEY);
              if (savedRaw) {
                const saved = JSON.parse(savedRaw);
                mlEventCount = saved.snoreCount || 0;
              }
            } catch (_) {}

            const score = calculateSnoreScore(nativeData, SENSITIVITY_LEVELS[activeSensitivity], mlEventCount);

            let logMessage = `━━━ SESSION RECOVERED ━━━\nStarted: ${sessionStart.toLocaleString()}\nEnded: ${sessionEnd.toLocaleString()}\nData points: ${nativeData.length}\nSensitivity: ${activeSensitivity} (${SENSITIVITY_LEVELS[activeSensitivity]} dB)\nAudio range: ${minLevel.toFixed(1)} to ${maxLevel.toFixed(1)} dB\n`;

            if (dbSnoreEvents.length > 0) {
              dbSnoreEvents.forEach(event => {
                const eventTime = new Date(event.time).toLocaleTimeString();
                const dB = Math.abs(event.level).toFixed(1);
                logMessage += `🔊 Loud snoring (${dB} dB) at ${eventTime}\n`;
              });
            } else if (mlEventCount > 0) {
              logMessage += `ML detected ${mlEventCount} snore events (audio peaks near ${SENSITIVITY_LEVELS[activeSensitivity]} dB threshold)\n`;
            } else {
              logMessage += `No snore events detected\n`;
            }

            logMessage += `📊 ${mlEventCount} ML detections, ${dbSnoreEvents.length} threshold crossings. Score: ${score}/100`;
            await logEvent(logMessage);
          }
          return nativeData || [];
        } catch (e) {
          await logEvent(`Failed to sync native data: ${e.message}`);
        }
      }
      return [];
    };

    const checkRecoveredSession = async () => {
      const recoveredData = await syncDataFromNative();
      if (recoveredData.length > 0) {
        setSessionStartTime(new Date(recoveredData[0].time));
        setSessionEndTime(new Date(recoveredData[recoveredData.length - 1].time));
      }
    };

    // Request notification permissions and load all persisted settings,
    // then recover any native session — all in a single async sequence so
    // sensitivity is guaranteed to be set before checkRecoveredSession runs.
    (async () => {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Notifications Disabled', 'Please enable notifications to receive daily reminders and session summaries.');
      }

      // Load saved preferences
      const savedReminderEnabled = await AsyncStorage.getItem('dailyReminderEnabled');
      if (savedReminderEnabled !== null) {
        setDailyReminderEnabled(JSON.parse(savedReminderEnabled));
      }

      const savedReminderTime = await AsyncStorage.getItem('reminderTime');
      if (savedReminderTime !== null) {
        setReminderTime(savedReminderTime);
      }

      const savedTrainingRecording = await AsyncStorage.getItem(TRAINING_RECORDING_KEY);
      if (savedTrainingRecording !== null) {
        setTrainingRecordingEnabled(JSON.parse(savedTrainingRecording));
      }

      // Load sensitivity FIRST — sensitivityRef.current must be correct before
      // checkRecoveredSession runs below.
      const savedSensitivity = await AsyncStorage.getItem('sensitivity');
      if (savedSensitivity !== null && SENSITIVITY_LEVELS[savedSensitivity] !== undefined) {
        sensitivityRef.current = savedSensitivity;
        setSensitivity(savedSensitivity);
      }

      // Check for active gift code
      try {
        const savedCode = await AsyncStorage.getItem(GIFT_CODE_KEY);
        const savedExpiry = await AsyncStorage.getItem(GIFT_CODE_EXPIRES_KEY);
        if (savedCode && savedExpiry) {
          const expiryDate = new Date(savedExpiry);
          if (expiryDate > new Date()) {
            setGiftCodeActive(true);
            logEvent(`Gift code active: ${savedCode}, expires ${expiryDate.toLocaleDateString()}`);
          } else {
            logEvent('Gift code expired');
            await AsyncStorage.removeItem(GIFT_CODE_KEY);
            await AsyncStorage.removeItem(GIFT_CODE_EXPIRES_KEY);
          }
        }
      } catch (e) {
        logEvent(`Failed to load gift code: ${e.message}`);
      }

      // Load last session from persistent storage
      try {
        const savedSession = await AsyncStorage.getItem(LAST_SESSION_KEY);
        if (savedSession) {
          const { data, startTime, endTime, snoreCount } = JSON.parse(savedSession);
          if (data && data.length > 0) {
            setSessionData(data);
            setSessionStartTime(new Date(startTime));
            setSessionEndTime(new Date(endTime));
            setSnoreEventCount(snoreCount || 0);
            if (savedSession.trainingRecordingPath) setRecordingPath(savedSession.trainingRecordingPath);
            logEvent(`Loaded previous session from storage (${data.length} points)`);
          }
        }
      } catch (e) {
        logEvent(`Failed to load session from storage: ${e.message}`);
      }

      // Recover any in-progress native session — runs AFTER sensitivity is loaded.
      await checkRecoveredSession();

      // Mark initial load as complete (this state change will trigger the scheduling useEffect)
      setIsInitialLoadComplete(true);
    })();

    const setupDetector = () => {
      snoreDetectorRef.current = new SnoreDetector(
        async (level, mlConfidence) => {
          const detectionType = mlConfidence !== undefined
            ? `ML confidence=${(mlConfidence * 100).toFixed(1)}%`
            : 'dB threshold';
          logEvent(`SNORE detected [${detectionType}] level=${level.toFixed(1)} dB`);
          setLastSnoreLevel(level);

          const now = Date.now();
          const timeSinceLastNotif = now - lastNotificationTimeRef.current;
          const canNotify = now - lastNotificationTimeRef.current >= NOTIFICATION_COOLDOWN_MS;
          logEvent(`Time since last notification: ${timeSinceLastNotif}ms (cooldown: ${NOTIFICATION_COOLDOWN_MS}ms)`);

          // Count every sustained ML detection even when notifications are throttled,
          // so analytics reflect actual detected events instead of alert frequency.
          snoreCountRef.current += 1;
          const times = mlDetectionTimesRef.current;
          times.push(now);
          if (times.length > 500) times.shift(); // keep last 500 for stop-time reporting
          setSnoreEventCount(snoreCountRef.current);

          if (canNotify) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);

            if (WatchConnectivityBridge?.sendVibrateCommand) {
              try {
                WatchConnectivityBridge.sendVibrateCommand();
                logEvent('Sent 5-pulse watch alert command');
              } catch (error) {
                logEvent(`ERROR sending watch alert command: ${error.message || error}`);
              }
            }

            if (NotificationBridge) {
              try {
                NotificationBridge.scheduleImmediateNotification(
                  'Snore detected',
                  'Reposition to reduce snoring.'
                );
                logEvent('Scheduled local snore notification (native)');
                lastNotificationTimeRef.current = now;
              } catch (error) {
                logEvent(`ERROR scheduling notification: ${error.message || error}`);
                console.error('Notification error:', error);
              }
            } else {
              // Fallback to Expo notifications when native module is not available (e.g., in simulator)
              try {
                await Notifications.scheduleNotificationAsync({
                  content: {
                    title: 'Snore detected',
                    body: 'Reposition to reduce snoring.',
                    sound: true,
                  },
                  trigger: null, // Show immediately
                });
                logEvent('Scheduled local snore notification (Expo fallback)');
                lastNotificationTimeRef.current = now;
              } catch (error) {
                logEvent(`ERROR scheduling Expo notification: ${error.message || error}`);
                console.error('Expo notification error:', error);
              }
            }
          } else {
            logEvent('Notification suppressed by cooldown; ML event still counted');
          }
        },
        (level) => {
          setCurrentAudioLevel(level);
          const now = Date.now();
          if (now - lastLogTimeRef.current >= 300000) { // every 5 minutes
            logEvent(`Audio Level: ${level.toFixed(1)} dB`);
            lastLogTimeRef.current = now;
          }

          if (now - lastDataPointTimeRef.current >= 5000) {
            if (level > -100) {
              const newDataPoint = { time: new Date().toISOString(), level: level };
              setSessionData(prev => [...prev, newDataPoint]);
              if (SleepSessionBridge) {
                SleepSessionBridge.logDataPoint(newDataPoint);
              }
            }
            lastDataPointTimeRef.current = now;
          }
        }
      );
      snoreDetectorRef.current.SNORE_THRESHOLD = SENSITIVITY_LEVELS[sensitivityRef.current];
      snoreDetectorRef.current.setTrainingRecordingEnabled(trainingRecordingEnabled);
    };

    setupDetector();

    const handleAppStateChange = (nextAppState) => {
      if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
        logEvent('App came to foreground, syncing data...');
        syncDataFromNative();
      }
      appState.current = nextAppState;
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);

    const notifResponseSub = Notifications.addNotificationResponseReceivedListener((response) => {
      const type = response.notification.request.content.data?.type;
      if (type === 'summary') {
        setShowAnalytics(true);
      }
    });

    return () => {
      logEvent('App unmounting');
      subscription.remove();
      notifResponseSub.remove();
      if (snoreDetectorRef.current) {
        snoreDetectorRef.current.stopMonitoring();
      }
    };
  }, []);

  useEffect(() => {
    sensitivityRef.current = sensitivity;
    AsyncStorage.setItem('sensitivity', sensitivity);
    if (snoreDetectorRef.current) {
      snoreDetectorRef.current.SNORE_THRESHOLD = SENSITIVITY_LEVELS[sensitivity];
      logEvent(`Sensitivity updated to ${sensitivity} (${SENSITIVITY_LEVELS[sensitivity]} dB)`);
    }
  }, [sensitivity]);

  useEffect(() => {
    AsyncStorage.setItem(TRAINING_RECORDING_KEY, JSON.stringify(trainingRecordingEnabled));
    if (snoreDetectorRef.current) {
      snoreDetectorRef.current.setTrainingRecordingEnabled(trainingRecordingEnabled);
    }
  }, [trainingRecordingEnabled]);

  const startMonitoring = async () => {
    logEvent('startMonitoring called');
    if (!snoreDetectorRef.current) return;

    // Subscription gate — pass if subscribed or gift code is active
    if (!hasActiveSubscription && !giftCodeActive) {
      if (isLoadingSubscription) return; // Still verifying — wait silently
      setShowPaywall(true);
      return;
    }

    let keepAwakeEnabled = false;
    try {
        const hasPermission = await snoreDetectorRef.current.requestPermissions();
        if (!hasPermission) {
          Alert.alert('Permission Required', 'Microphone access is needed to detect snoring.');
          return;
        }

        if (NotificationBridge?.requestAuthorization) {
          try {
            const granted = await NotificationBridge.requestAuthorization();
            logEvent(`Notification permission granted: ${granted}`);
          } catch (e) {
            logEvent(`Notification permission error: ${e.message || e}`);
          }
        }

        const startTime = new Date();
        setSessionData([]);
        setSessionStartTime(startTime);
        setSessionEndTime(null);
        setShowAnalytics(false);
        lastDataPointTimeRef.current = 0;
        lastLogTimeRef.current = 0;
        lastNotificationTimeRef.current = 0;
        snoreCountRef.current = 0;
        mlDetectionTimesRef.current = [];
        inMemoryLogs.length = 0; // start fresh — only current session visible in logs
        setSnoreEventCount(0);

        // Log session start with clear separator
        const startLog = `\n${'='.repeat(50)}\n━━━ SLEEP SESSION STARTED ━━━\nTime: ${startTime.toLocaleString()}\nSensitivity: ${sensitivity} (${SENSITIVITY_LEVELS[sensitivity]} dB)`;
        await logEvent(startLog);
        if (trainingRecordingEnabled) {
          await logEvent('Training audio capture enabled for this session');
        }

        await activateKeepAwakeAsync();
        keepAwakeEnabled = true;

        if (SleepSessionBridge) {
          SleepSessionBridge.clearNativeData();
          SleepSessionBridge.startSleepSession();
        }

        if (WatchConnectivityBridge?.startWatchSession) {
          try {
            WatchConnectivityBridge.startWatchSession();
            logEvent('Watch session activated for overnight monitoring');
          } catch (e) {
            logEvent(`Watch session activation error: ${e.message || e}`);
          }
        }

        snoreDetectorRef.current.setTrainingRecordingEnabled(trainingRecordingEnabled);
        await snoreDetectorRef.current.startMonitoring();
        isMonitoringRef.current = true;
        setIsMonitoring(true);
    } catch (error) {
        logEvent(`Error in startMonitoring: ${error.message}`);
        if (keepAwakeEnabled) {
          try {
            await deactivateKeepAwake();
          } catch (e) {
            logEvent(`Error deactivating keep awake after start failure: ${e.message}`);
          }
        }
        Alert.alert('Error', `Failed to start monitoring: ${error.message}`);
    }
  };

  const stopMonitoring = async () => {
    if (!snoreDetectorRef.current) return;
    try {
        await snoreDetectorRef.current.stopMonitoring();
        let finalData = sessionData;
        if (SleepSessionBridge) {
          const nativeData = await SleepSessionBridge.getNativeData();
          if (nativeData && nativeData.length > 0) {
            setSessionData(nativeData);
            finalData = nativeData;
          }
          SleepSessionBridge.stopSleepSession();
        }

        if (WatchConnectivityBridge?.stopWatchSession) {
          try {
            WatchConnectivityBridge.stopWatchSession();
            logEvent('Watch session marked inactive');
          } catch (e) {
            logEvent(`Watch session stop error: ${e.message || e}`);
          }
        }
        isMonitoringRef.current = false;
        setIsMonitoring(false);
        setLastSnoreLevel(null);
        setCurrentAudioLevel(null);
        const endTime = new Date();
        setSessionEndTime(endTime);
        setShowAnalytics(true);

        // Build complete log message
        const snoreEvents = finalData.filter(d => d.level > SENSITIVITY_LEVELS[sensitivity]);
        const snoreCount = snoreEvents.length;
        const sessionScore = calculateSnoreScore(finalData, SENSITIVITY_LEVELS[sensitivity], snoreCountRef.current);

        let logMessage = `━━━ SLEEP SESSION ENDED ━━━\nTime: ${endTime.toLocaleString()}\nData points: ${finalData.length}\nSensitivity: ${sensitivity} (${SENSITIVITY_LEVELS[sensitivity]} dB)\n`;

        if (finalData.length > 0) {
          const levels = finalData.map(d => d.level);
          const maxLevel = Math.max(...levels);
          const minLevel = Math.min(...levels);
          logMessage += `Audio range: ${minLevel.toFixed(1)} to ${maxLevel.toFixed(1)} dB\n`;
        }

        const mlDetectionCount = snoreCountRef.current;
        const mlTimes = mlDetectionTimesRef.current;
        const trainingRecordingPath = snoreDetectorRef.current.getLastTrainingRecordingPath?.();
        if (trainingRecordingPath) setRecordingPath(trainingRecordingPath);

        if (snoreCount > 0) {
          snoreEvents.forEach(event => {
            const eventTime = new Date(event.time).toLocaleTimeString();
            const dB = Math.abs(event.level).toFixed(1);
            logMessage += `🔊 Loud snoring (${dB} dB) at ${eventTime}\n`;
          });
        } else if (mlDetectionCount > 0) {
          const showTimes = mlTimes.slice(-20); // last 20 logged events
          showTimes.forEach((ts, i) => {
            logMessage += `🤖 ML snore at ${new Date(ts).toLocaleTimeString()}\n`;
          });
          if (mlDetectionCount > 20) {
            logMessage += `  … and ${mlDetectionCount - 20} earlier events\n`;
          }
        } else {
          logMessage += `No snoring detected this session\n`;
        }

        logMessage += `📊 ${mlDetectionCount} ML detections. Score: ${sessionScore}/100\n${'='.repeat(50)}`;
        if (trainingRecordingPath) {
          logMessage += `\nTraining audio saved:\n${trainingRecordingPath}`;
        }

        await logEvent(logMessage);

        // Write the complete session log to a timestamped file alongside the audio.
        // One atomic write at session end — never fragmented by overnight JS suspensions.
        await flushSessionLog(sessionStartTime);

        await Notifications.scheduleNotificationAsync({
          content: {
            title: 'SnoreAlert — Session Complete',
            body: mlDetectionCount > 0
              ? `${mlDetectionCount} snore events detected. Tap to view your sleep report.`
              : `No snoring detected. Great night! Tap to view your sleep report.`,
            data: { type: 'summary' },
          },
          trigger: null, // immediate
        });

        // Save session to AsyncStorage for persistence across app restarts
        try {
          const lastSession = {
            data: finalData,
            startTime: sessionStartTime?.toISOString(),
            endTime: endTime.toISOString(),
            savedAt: new Date().toISOString(),
            snoreCount: snoreCountRef.current,
            trainingRecordingPath,
          };
          await AsyncStorage.setItem(LAST_SESSION_KEY, JSON.stringify(lastSession));
          logEvent('Session saved to persistent storage');
          // Clear the native disk file — session is now safely in AsyncStorage.
          // If we don't clear it, the next launch will trigger a false "SESSION RECOVERED"
          // log that shows 0 dB-threshold events and ignores the ML event count.
          if (SleepSessionBridge) {
            SleepSessionBridge.clearNativeData();
          }
        } catch (e) {
          logEvent(`Failed to save session to storage: ${e.message}`);
        }
    } catch (error) {
        logEvent(`Error in stopMonitoring: ${error.message}`);
    } finally {
        deactivateKeepAwake();
    }
  };

  const formatDuration = () => {
    if (!sessionStartTime || !sessionEndTime) return '';
    const diff = sessionEndTime - sessionStartTime;
    const seconds = Math.floor(diff / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`;
  };

  const formatPlaybackTime = (ms) => {
    const totalSec = Math.floor((ms || 0) / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const loadPlaybackAudio = async (path) => {
    try {
      if (playbackSoundRef.current) {
        await playbackSoundRef.current.unloadAsync().catch(() => {});
        playbackSoundRef.current = null;
      }

      // Apply voice filter (low-pass ~300 Hz) — removes speech, keeps snoring/breathing.
      // Falls back to the original file if native processing is unavailable or fails.
      let playPath = path;
      if (NativeModules.NativeAudioRecorder?.processAudioForPlayback) {
        try {
          logEvent('Filtering voice from recording for playback…');
          playPath = await NativeModules.NativeAudioRecorder.processAudioForPlayback(path);
          logEvent('Voice filter applied');
        } catch (e) {
          logEvent(`Voice filter failed (using original): ${e.message}`);
        }
      }

      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        { uri: 'file://' + playPath },
        { shouldPlay: false },
        (status) => {
          if (status.isLoaded) {
            setPlaybackStatus({
              isPlaying: status.isPlaying,
              positionMs: status.positionMillis || 0,
              durationMs: status.durationMillis || 0,
            });
            if (status.didJustFinish) {
              sound.setPositionAsync(0).catch(() => {});
            }
          }
        }
      );
      playbackSoundRef.current = sound;
    } catch (e) {
      logEvent(`Playback load error: ${e.message}`);
    }
  };

  const handlePlayPause = async () => {
    if (!playbackSoundRef.current) return;
    if (playbackStatus.isPlaying) {
      await playbackSoundRef.current.pauseAsync();
    } else {
      await playbackSoundRef.current.playAsync();
    }
  };

  const handleSeek = async (deltaMs) => {
    if (!playbackSoundRef.current) return;
    const newPos = Math.max(0, Math.min(playbackStatus.durationMs, playbackStatus.positionMs + deltaMs));
    await playbackSoundRef.current.setPositionAsync(newPos);
  };

  const handleBackFromAnalytics = async () => {
    if (playbackSoundRef.current) {
      await playbackSoundRef.current.stopAsync().catch(() => {});
      await playbackSoundRef.current.unloadAsync().catch(() => {});
      playbackSoundRef.current = null;
    }
    setPlaybackStatus({ isPlaying: false, positionMs: 0, durationMs: 0 });
    setActiveAnalyticsTab('stats');
    setShowAnalytics(false);
  };

  const viewLogs = async () => {
    try {
      const MAX_LOG_CHARS = 30000;
      let content = '';

      // Primary: in-memory buffer — always up-to-date for the current app session.
      // File writes can silently fail when the JS thread is suspended (phone locked).
      if (inMemoryLogs.length > 0) {
        content = inMemoryLogs.join('');
      } else {
        // Fallback: file — for logs from a previous app session (after app restart)
        const fileInfo = await FileSystem.getInfoAsync(LOG_FILE);
        if (fileInfo.exists) {
          content = await FileSystem.readAsStringAsync(LOG_FILE);
        }
      }

      if (!content || content.trim().length === 0) {
        Alert.alert('App Logs', 'No logs available yet.');
        return;
      }

      const displayContent = content.length > MAX_LOG_CHARS
        ? `[earlier logs omitted — showing last ${MAX_LOG_CHARS} chars]\n\n` + content.slice(-MAX_LOG_CHARS)
        : content;
      setLogContent(displayContent);
      setShowLogsModal(true);
    } catch (e) {
      Alert.alert('Error', `Failed to read logs: ${e.message}`);
    }
  };

  const clearLogs = async () => {
    try {
      await FileSystem.deleteAsync(LOG_FILE, { idempotent: true });
      await AsyncStorage.removeItem(LAST_SESSION_KEY);
      await AsyncStorage.removeItem(GIFT_CODE_KEY);
      await AsyncStorage.removeItem(GIFT_CODE_EXPIRES_KEY);
      setGiftCodeActive(false);
      setSessionData([]);
      setSessionStartTime(null);
      setSessionEndTime(null);
      Alert.alert('Success', 'Logs and session data cleared');
      logEvent('Logs and session data cleared manually');
    } catch (e) {
      Alert.alert('Error', 'Failed to clear logs');
    }
  };

  // Notification helper functions
  const scheduleDailyReminder = async () => {
    const NotificationBridge = NativeModules.NotificationBridge;

    // Cancel any existing reminder via native bridge (uses fixed identifier)
    if (NotificationBridge && NotificationBridge.cancelDailyReminder) {
      NotificationBridge.cancelDailyReminder();
    }

    if (!dailyReminderEnabled) {
      logEvent('Daily reminder disabled, not scheduling');
      return;
    }

    const [hours, minutes] = reminderTime.split(':').map(Number);

    if (NotificationBridge && NotificationBridge.scheduleDailyReminderAt) {
      // Native UNCalendarNotificationTrigger — reliable on iOS 18
      NotificationBridge.scheduleDailyReminderAt(hours, minutes);
      logEvent(`Daily reminder scheduled natively — repeats every day at ${reminderTime}`);
    } else {
      // Fallback: Expo scheduler (simulator / dev builds without native module).
      // Cancel any existing Expo daily-reminder before scheduling to avoid duplicates.
      const existing = await Notifications.getAllScheduledNotificationsAsync();
      for (const n of existing) {
        if (n.content.data?.type === 'daily-reminder') {
          await Notifications.cancelScheduledNotificationAsync(n.identifier);
        }
      }
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'SnoreAlert',
          body: `🌙 Time to track your sleep tonight! Make sure your iPhone is charged and ready.`,
          data: { type: 'daily-reminder' },
        },
        trigger: {
          hour: hours,
          minute: minutes,
          repeats: true,
        },
      });
      logEvent(`Daily reminder scheduled via Expo — repeats every day at ${reminderTime}`);
    }
  };

  const toggleDailyReminder = async (value) => {
    setDailyReminderEnabled(value);
    await AsyncStorage.setItem('dailyReminderEnabled', JSON.stringify(value));
    // scheduleDailyReminder will be called automatically by the useEffect below

    // Show confirmation message
    Alert.alert(
      value ? 'Notifications Enabled' : 'Notifications Disabled',
      value
        ? `You'll receive a daily reminder at ${reminderTime} to start monitoring.`
        : 'Daily reminders have been turned off.'
    );
  };

  const toggleTrainingRecording = async (value) => {
    setTrainingRecordingEnabled(value);
    await AsyncStorage.setItem(TRAINING_RECORDING_KEY, JSON.stringify(value));
    Alert.alert(
      value ? 'Training Capture Enabled' : 'Training Capture Disabled',
      value
        ? 'Future sessions will save microphone audio on this iPhone for model improvement.'
        : 'Future sessions will only save detection summary data.'
    );
  };

  // Schedule daily reminder when time changes, on initial load, or when toggled on/off
  useEffect(() => {
    if (isInitialLoadComplete) {
      scheduleDailyReminder();
    }
  }, [reminderTime, isInitialLoadComplete, dailyReminderEnabled]);

  // When toggling on/off, manually call cancel if disabled
  useEffect(() => {
    if (isInitialLoadComplete && !dailyReminderEnabled) {
      (async () => {
        const scheduledNotifications = await Notifications.getAllScheduledNotificationsAsync();
        for (const notification of scheduledNotifications) {
          if (notification.content.data?.type === 'daily-reminder') {
            await Notifications.cancelScheduledNotificationAsync(notification.identifier);
          }
        }
      })();
    }
  }, [dailyReminderEnabled, isInitialLoadComplete]);

  // ─── IAP Helpers ────────────────────────────────────────────────────────────

  const checkSubscriptionStatus = async () => {
    try {
      const purchases = await getAvailablePurchases();
      const active = purchases.find(
        p => p.productId === SUBSCRIPTION_SKUS.monthly ||
             p.productId === SUBSCRIPTION_SKUS.annual
      );
      setHasActiveSubscription(!!active);
      if (active) {
        logEvent(`Subscription active: ${active.productId}`);
      }
    } catch (err) {
      logEvent(`Subscription check error: ${err.message}`);
    } finally {
      setIsLoadingSubscription(false);
    }
  };

  const purchaseSubscription = async (sku) => {
    setIsPurchasing(true);
    try {
      await requestPurchase({
        request: { apple: { sku } },
        type: 'subs',
      });
    } catch (err) {
      if (err.code !== 'E_USER_CANCELLED') {
        Alert.alert('Purchase Error', err.message || 'Something went wrong. Please try again.');
      }
      setIsPurchasing(false);
    }
  };

  const restorePurchases = async () => {
    setIsPurchasing(true);
    try {
      const purchases = await getAvailablePurchases();
      const active = purchases.find(
        p => p.productId === SUBSCRIPTION_SKUS.monthly ||
             p.productId === SUBSCRIPTION_SKUS.annual
      );
      if (active) {
        setHasActiveSubscription(true);
        setShowPaywall(false);
        Alert.alert('Restored', 'Your subscription has been restored.');
        logEvent('Purchases restored successfully');
      } else {
        Alert.alert('No Subscription Found', 'No active subscription was found for this Apple ID.');
      }
    } catch (err) {
      Alert.alert('Restore Error', err.message || 'Could not restore purchases.');
    } finally {
      setIsPurchasing(false);
    }
  };

  // ─── Gift Code Helpers ───────────────────────────────────────────────────────

  const redeemGiftCode = async (code) => {
    const trimmed = code.trim().toUpperCase();
    if (GIFT_CODES.includes(trimmed)) {
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + GIFT_CODE_DURATION_DAYS);
      await AsyncStorage.setItem(GIFT_CODE_KEY, trimmed);
      await AsyncStorage.setItem(GIFT_CODE_EXPIRES_KEY, expiry.toISOString());
      setGiftCodeActive(true);
      setShowPaywall(false);
      logEvent(`Gift code redeemed: ${trimmed}, expires ${expiry.toLocaleDateString()}`);
      Alert.alert(
        '🎁 Code Redeemed!',
        `You have ${GIFT_CODE_DURATION_DAYS} days of full access to SnoreAlert. Enjoy!`
      );
    } else {
      Alert.alert('Invalid Code', 'That code is not valid or has already been used. Please check and try again.');
    }
  };

  const promptGiftCode = () => {
    Alert.prompt(
      'Enter Gift Code',
      'Enter the code you received to unlock access.',
      (code) => { if (code) redeemGiftCode(code); },
      'plain-text',
      '',
      'default'
    );
  };

  // IAP setup — init connection, load products, check subscription
  useEffect(() => {
    let purchaseUpdateSub;
    let purchaseErrorSub;

    const setupIAP = async () => {
      try {
        await initConnection();

        purchaseUpdateSub = purchaseUpdatedListener(async (purchase) => {
          try {
            await finishTransaction({ purchase });
            await checkSubscriptionStatus();
            setShowPaywall(false);
            logEvent('Purchase completed and verified');
          } catch (err) {
            logEvent(`finishTransaction error: ${err.message}`);
          }
        });

        purchaseErrorSub = purchaseErrorListener((err) => {
          logEvent(`Purchase error: ${err.code} ${err.message}`);
          setIsPurchasing(false);
        });

        const products = await fetchProducts({
          skus: Object.values(SUBSCRIPTION_SKUS),
          type: 'subs',
        });
        // Sort annual first
        const sorted = [...products].sort((a, b) => {
          if (a.productId.includes('annual') && !b.productId.includes('annual')) return -1;
          if (!a.productId.includes('annual') && b.productId.includes('annual')) return 1;
          return 0;
        });
        setSubscriptionProducts(sorted);

        await checkSubscriptionStatus();
      } catch (err) {
        logEvent(`IAP setup error: ${err.message}`);
        setIsLoadingSubscription(false);
      }
    };

    setupIAP();

    return () => {
      purchaseUpdateSub?.remove();
      purchaseErrorSub?.remove();
      endConnection();
    };
  }, []);

  // Analytics Screen
  if (showAnalytics) {
    const validSessionData = sessionData.filter(d => d.level > -100);

    // ── Stats tab data ──────────────────────────────────────────────────────
    const maxPoints = 50;
    let chartData = validSessionData;
    if (validSessionData.length > maxPoints) {
      const step = Math.ceil(validSessionData.length / maxPoints);
      chartData = validSessionData.filter((_, index) => index % step === 0);
    }

    const labels = chartData.map((d, i) => {
      const isFirst = i === 0;
      const isLast = i === chartData.length - 1;
      const isTenth = i % 10 === 0;
      const tooCloseToEnd = i >= chartData.length - 5;
      if (isFirst) return new Date(d.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (isLast && sessionEndTime) return sessionEndTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (isTenth && !tooCloseToEnd) return new Date(d.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return "";
    });

    const data = {
      labels,
      datasets: [{ data: chartData.length > 0 ? chartData.map(d => d.level) : [0] }]
    };

    const snoreScore = calculateSnoreScore(sessionData, SENSITIVITY_LEVELS[sensitivity], snoreEventCount);
    const snoreEvents = snoreEventCount;
    const avgLevel = validSessionData.length > 0
      ? (validSessionData.reduce((sum, d) => sum + d.level, 0) / validSessionData.length).toFixed(1)
      : 0;

    // ── Waveform tab data ───────────────────────────────────────────────────
    const MAX_BARS = 500;
    const rawWaveformData = validSessionData.length <= MAX_BARS
      ? validSessionData
      : validSessionData.filter((_, i) => i % Math.ceil(validSessionData.length / MAX_BARS) === 0).slice(0, MAX_BARS);

    // Zoom window — slice raw data to the visible fraction of the session
    const visibleHalf  = 0.5 / waveZoom;
    const visibleStart = Math.max(0, waveOffset - visibleHalf);
    const visibleEnd   = Math.min(1, waveOffset + visibleHalf);
    const _startIdx = Math.floor(visibleStart * rawWaveformData.length);
    const _endIdx   = Math.max(_startIdx + 2, Math.ceil(visibleEnd * rawWaveformData.length));
    const waveformData = rawWaveformData.slice(_startIdx, Math.min(_endIdx, rawWaveformData.length));

    // Wallclock times for visible window edges
    const _sessionDurationMs = sessionStartTime && sessionEndTime ? sessionEndTime - sessionStartTime : 0;
    const visibleStartTime = sessionStartTime && _sessionDurationMs
      ? new Date(sessionStartTime.getTime() + visibleStart * _sessionDurationMs) : sessionStartTime;
    const visibleEndTime = sessionStartTime && _sessionDurationMs
      ? new Date(sessionStartTime.getTime() + visibleEnd * _sessionDurationMs) : sessionEndTime;

    // displayProgress: use scrubber drag value while dragging, else live position
    const displayProgress = scrubProgress >= 0
      ? scrubProgress
      : (playbackStatus.durationMs > 0 ? playbackStatus.positionMs / playbackStatus.durationMs : 0);
    const pct = Math.min(100, Math.max(0, Math.round(displayProgress * 100)));

    // ── SVG line chart ──────────────────────────────────────────────────────
    // Use 2nd–98th percentile for Y-axis bounds so a single startup spike
    // (common at session start) doesn't compress the entire waveform.
    const _wfLevels = waveformData.map(d => d.level).sort((a, b) => a - b);
    const _p2  = _wfLevels[Math.max(0, Math.floor(_wfLevels.length * 0.02))] ?? -80;
    const _p98 = _wfLevels[Math.min(_wfLevels.length - 1, Math.floor(_wfLevels.length * 0.98))] ?? -20;
    const wfMin = waveformData.length > 0 ? _p2  : -80;
    const wfMax = waveformData.length > 0 ? _p98 : -20;
    const wfRange = Math.max(15, wfMax - wfMin);

    const SVG_H = 110;
    const SVG_W = Math.max(100, waveformWidth - 16);

    // Add 20% headroom above and below the data range so the waveform
    // doesn't press against the container edges
    const wfPadding = wfRange * 0.20;
    const displayMin = wfMin - wfPadding;
    const displayRange = wfRange + wfPadding * 2;

    const getYPos = (level) => {
      const n = Math.max(0, Math.min(1, (level - displayMin) / displayRange));
      return (SVG_H - 4) - n * (SVG_H - 8) + 2; // flip: loud = low y (top of container)
    };

    const linePoints = waveformData.map((d, i) => [
      (i / Math.max(1, waveformData.length - 1)) * SVG_W,
      getYPos(d.level),
    ]);

    const buildSvgPath = (pts) => {
      if (pts.length < 2) return '';
      if (pts.length > 200) {
        // Straight lines for dense datasets — sub-pixel segments look smooth anyway
        return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
      }
      // Catmull-Rom bezier for sparse datasets
      const t = 0.4;
      let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(pts.length - 1, i + 2)];
        const cp1x = p1[0] + (p2[0] - p0[0]) * t;
        const cp1y = p1[1] + (p2[1] - p0[1]) * t;
        const cp2x = p2[0] - (p3[0] - p1[0]) * t;
        const cp2y = p2[1] - (p3[1] - p1[1]) * t;
        d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
      }
      return d;
    };

    const svgLinePath = buildSvgPath(linePoints);
    const x0 = linePoints.length > 0 ? linePoints[0][0].toFixed(1) : '0';
    const xN = linePoints.length > 0 ? linePoints[linePoints.length - 1][0].toFixed(1) : String(SVG_W);
    const svgFillPath = svgLinePath
      ? `M${x0},${SVG_H} ${svgLinePath.replace('M', 'L')} L${xN},${SVG_H} Z`
      : null;

    // Threshold line in SVG coordinates
    const thresholdLevel = SENSITIVITY_LEVELS[sensitivity];
    const thresholdY = getYPos(Math.max(wfMin + 0.1, Math.min(wfMax - 0.1, thresholdLevel)));
    const showThreshold = thresholdLevel > wfMin && thresholdLevel < wfMax;

    // Playback cursor X — zoom-aware: map displayProgress into the visible window
    const cursorInView = displayProgress >= visibleStart && displayProgress <= visibleEnd;
    const cursorX = cursorInView
      ? ((displayProgress - visibleStart) / (visibleEnd - visibleStart)) * SVG_W
      : -1;

    // Waveform pinch-to-zoom + pan gesture handlers
    const onWaveformGrant = (e) => {
      const touches = e.nativeEvent.touches;
      if (touches?.length >= 2) {
        const dx = touches[0].pageX - touches[1].pageX;
        const dy = touches[0].pageY - touches[1].pageY;
        waveGestureRef.current.pinchInitialDist = Math.sqrt(dx * dx + dy * dy);
        waveGestureRef.current.pinchInitialZoom = waveZoom;
        waveGestureRef.current.panLastX = null;
      } else {
        waveGestureRef.current.pinchInitialDist = null;
        waveGestureRef.current.panLastX = touches?.[0]?.pageX ?? null;
        const now = Date.now();
        if (now - waveGestureRef.current.lastTapTime < 300) {
          setWaveZoom(1.0);
          setWaveOffset(0.5);
        }
        waveGestureRef.current.lastTapTime = now;
      }
    };
    const onWaveformMove = (e) => {
      const touches = e.nativeEvent.touches;
      if (touches?.length >= 2 && waveGestureRef.current.pinchInitialDist) {
        const dx = touches[0].pageX - touches[1].pageX;
        const dy = touches[0].pageY - touches[1].pageY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const scale = dist / waveGestureRef.current.pinchInitialDist;
        const newZoom = Math.max(1, Math.min(8, waveGestureRef.current.pinchInitialZoom * scale));
        setWaveZoom(newZoom);
        setWaveOffset(prev => {
          const hw = 0.5 / newZoom;
          return Math.max(hw, Math.min(1 - hw, prev));
        });
      } else if (touches?.length === 1 && waveZoom > 1 && waveGestureRef.current.panLastX !== null) {
        const deltaFraction = -(touches[0].pageX - waveGestureRef.current.panLastX) / (waveformWidth || 300) / waveZoom;
        waveGestureRef.current.panLastX = touches[0].pageX;
        setWaveOffset(prev => {
          const hw = 0.5 / waveZoom;
          return Math.max(hw, Math.min(1 - hw, prev + deltaFraction));
        });
      }
    };
    const onWaveformRelease = () => {
      waveGestureRef.current.pinchInitialDist = null;
      waveGestureRef.current.panLastX = null;
    };

    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    const onScrubGrant = (e) => {
      scrubberRef.current.isDragging = true;
      setScrubProgress(clamp01(e.nativeEvent.locationX / (scrubberRef.current.width || 1)));
    };
    const onScrubMove = (e) => {
      setScrubProgress(clamp01(e.nativeEvent.locationX / (scrubberRef.current.width || 1)));
    };
    const onScrubRelease = async (e) => {
      const p = clamp01(e.nativeEvent.locationX / (scrubberRef.current.width || 1));
      scrubberRef.current.isDragging = false;
      setScrubProgress(-1);
      if (playbackSoundRef.current && playbackStatus.durationMs > 0) {
        await playbackSoundRef.current.setPositionAsync(p * playbackStatus.durationMs);
      }
    };

    return (
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <StatusBar style="light" />
          <ScrollView contentContainerStyle={styles.analyticsContent}>
            <View style={styles.analyticsHeader}>
              <Text style={styles.analyticsTitle}>Sleep Session</Text>
              <Text style={styles.analyticsDuration}>{formatDuration()}</Text>
            </View>

            {/* Tab Bar */}
            <View style={styles.analyticsTabBar}>
              <TouchableOpacity
                style={[styles.analyticsTab, activeAnalyticsTab === 'stats' && styles.analyticsTabActive]}
                onPress={() => setActiveAnalyticsTab('stats')}
              >
                <Text style={[styles.analyticsTabText, activeAnalyticsTab === 'stats' && styles.analyticsTabTextActive]}>
                  Stats
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.analyticsTab, activeAnalyticsTab === 'playback' && styles.analyticsTabActive]}
                onPress={async () => {
                  setActiveAnalyticsTab('playback');
                  if (!playbackSoundRef.current && recordingPath) {
                    await loadPlaybackAudio(recordingPath);
                  }
                }}
              >
                <Text style={[styles.analyticsTabText, activeAnalyticsTab === 'playback' && styles.analyticsTabTextActive]}>
                  Playback
                </Text>
              </TouchableOpacity>
            </View>

            {/* ── Stats Tab ── */}
            {activeAnalyticsTab === 'stats' && (
              <>
                <View style={styles.scoreCard}>
                  <Text style={styles.scoreLabel}>Snore Score</Text>
                  <View style={styles.scoreCircle}>
                    <Text style={styles.scoreValue}>{snoreScore}</Text>
                    <Text style={styles.scoreMax}>/100</Text>
                  </View>
                  <Text style={styles.scoreDescription}>
                    {snoreScore === 0 ? '😴 No snoring detected' :
                     snoreScore < 10 ? '😴 Excellent sleep!' :
                     snoreScore < 30 ? '😊 Light snoring' :
                     snoreScore < 60 ? '😐 Moderate snoring' :
                     '😮 Heavy snoring detected'}
                  </Text>
                </View>

                <View style={styles.statsGrid}>
                  <View style={styles.statCard}>
                    <Text style={styles.statIcon}>🔊</Text>
                    <Text style={styles.statValue}>{snoreEvents}</Text>
                    <Text style={styles.statLabel}>Snore Events</Text>
                  </View>
                  <View style={styles.statCard}>
                    <Text style={styles.statIcon}>📊</Text>
                    <Text style={styles.statValue}>{avgLevel} dB</Text>
                    <Text style={styles.statLabel}>Avg Level</Text>
                  </View>
                </View>

                <View style={styles.chartCard}>
                  <Text style={styles.chartTitle}>Audio Levels</Text>
                  <LineChart
                    data={data}
                    width={Dimensions.get("window").width - 60}
                    height={220}
                    chartConfig={{
                      backgroundColor: "#ffffff",
                      backgroundGradientFrom: "#ffffff",
                      backgroundGradientTo: "#ffffff",
                      decimalPlaces: 1,
                      color: (opacity = 1) => `rgba(30, 60, 114, ${opacity})`,
                      labelColor: (opacity = 1) => `rgba(0, 0, 0, ${opacity})`,
                      propsForDots: { r: "3", strokeWidth: "2", stroke: "#1e3c72" }
                    }}
                    bezier
                    style={styles.chart}
                  />
                </View>
              </>
            )}

            {/* ── Playback Tab ── */}
            {activeAnalyticsTab === 'playback' && (
              <View style={styles.playbackCard}>
                {recordingPath ? (
                  <>
                    {/* Waveform — SVG line plot, pinch to zoom, double-tap to reset */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                      <Text style={styles.playbackSectionLabel}>Night Waveform</Text>
                      {waveZoom > 1 && (
                        <TouchableOpacity onPress={() => { setWaveZoom(1); setWaveOffset(0.5); }}>
                          <Text style={{ fontSize: 11, color: '#6b7280', paddingRight: 4 }}>Reset zoom</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                    <View
                      style={styles.waveformContainer}
                      onLayout={(e) => setWaveformWidth(e.nativeEvent.layout.width)}
                      onStartShouldSetResponder={() => true}
                      onMoveShouldSetResponder={() => true}
                      onResponderGrant={onWaveformGrant}
                      onResponderMove={onWaveformMove}
                      onResponderRelease={onWaveformRelease}
                      onResponderTerminate={onWaveformRelease}
                    >
                      {linePoints.length >= 2 ? (
                        <Svg width={SVG_W} height={SVG_H}>
                          <Defs>
                            <LinearGradient id="waveGrad" x1="0" y1="0" x2="0" y2="1">
                              <Stop offset="0%" stopColor="#10b981" stopOpacity="0.55" />
                              <Stop offset="100%" stopColor="#10b981" stopOpacity="0.03" />
                            </LinearGradient>
                          </Defs>
                          {svgFillPath && (
                            <Path d={svgFillPath} fill="url(#waveGrad)" />
                          )}
                          {showThreshold && (
                            <Line
                              x1="0" y1={thresholdY.toFixed(1)}
                              x2={SVG_W} y2={thresholdY.toFixed(1)}
                              stroke="#ef4444"
                              strokeWidth="1.5"
                              strokeDasharray="5,4"
                              strokeOpacity="0.75"
                            />
                          )}
                          {svgLinePath && (
                            <Path
                              d={svgLinePath}
                              fill="none"
                              stroke="#10b981"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          )}
                          {playbackStatus.durationMs > 0 && cursorX >= 0 && (
                            <Line
                              x1={cursorX.toFixed(1)} y1="0"
                              x2={cursorX.toFixed(1)} y2={SVG_H}
                              stroke="rgba(255,255,255,0.9)"
                              strokeWidth="2"
                            />
                          )}
                        </Svg>
                      ) : (
                        <Text style={{ color: '#9ca3af', fontSize: 13 }}>No session data</Text>
                      )}
                    </View>

                    {/* Time axis labels — show visible window edges */}
                    <View style={styles.waveformTimeRow}>
                      <Text style={styles.waveformTimeLabel}>
                        {visibleStartTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </Text>
                      {waveZoom > 1 && (
                        <Text style={{ fontSize: 10, color: '#6b7280' }}>{waveZoom.toFixed(1)}×</Text>
                      )}
                      <Text style={styles.waveformTimeLabel}>
                        {visibleEndTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </Text>
                    </View>

                    {/* Scrubber */}
                    <View
                      style={styles.scrubberWrapper}
                      onLayout={(e) => { scrubberRef.current.width = e.nativeEvent.layout.width; }}
                      onStartShouldSetResponder={() => true}
                      onMoveShouldSetResponder={() => true}
                      onResponderGrant={onScrubGrant}
                      onResponderMove={onScrubMove}
                      onResponderRelease={onScrubRelease}
                      onResponderTerminate={() => setScrubProgress(-1)}
                    >
                      <View style={styles.scrubberTrackBg} />
                      <View style={[styles.scrubberFill, { width: `${pct}%` }]} />
                      <View style={[styles.scrubberThumb, { left: `${pct}%` }]} />
                    </View>

                    {/* Position / duration */}
                    <View style={styles.playbackTimeRow}>
                      <Text style={styles.playbackTimeText}>
                        {formatPlaybackTime(scrubProgress >= 0 ? scrubProgress * playbackStatus.durationMs : playbackStatus.positionMs)}
                      </Text>
                      <Text style={styles.playbackTimeText}>{formatPlaybackTime(playbackStatus.durationMs)}</Text>
                    </View>

                    {/* Controls — skip back / play-pause / skip forward */}
                    <View style={styles.playbackControls}>
                      <TouchableOpacity style={styles.skipButton} onPress={() => handleSeek(-5000)}>
                        <Text style={styles.skipIcon}>↺</Text>
                        <Text style={styles.skipLabel}>5s</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.playPauseButton} onPress={handlePlayPause}>
                        <Text style={styles.playPauseIcon}>{playbackStatus.isPlaying ? '⏸' : '▶'}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.skipButton} onPress={() => handleSeek(5000)}>
                        <Text style={styles.skipIcon}>↻</Text>
                        <Text style={styles.skipLabel}>5s</Text>
                      </TouchableOpacity>
                    </View>

                    {/* Legend */}
                    <View style={styles.waveformLegend}>
                      <View style={styles.legendItem}>
                        <View style={styles.legendLine} />
                        <Text style={styles.legendText}>Audio Level</Text>
                      </View>
                      {showThreshold && (
                        <View style={styles.legendItem}>
                          <View style={styles.legendDashedLine} />
                          <Text style={styles.legendText}>Snore Threshold</Text>
                        </View>
                      )}
                    </View>
                  </>
                ) : (
                  <View style={styles.noRecordingView}>
                    <Text style={styles.noRecordingIcon}>🎙️</Text>
                    <Text style={styles.noRecordingTitle}>No Recording Available</Text>
                    <Text style={styles.noRecordingText}>
                      Enable "Training Audio Capture" in Session Settings before your next session to record overnight audio for playback.
                    </Text>
                  </View>
                )}
              </View>
            )}

            <TouchableOpacity style={styles.backButton} onPress={handleBackFromAnalytics}>
              <Text style={styles.backButtonText}>← Back to Home</Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </View>
    );
  }

  // Home Screen
  return (
    <View style={styles.container}>
      {/* Paywall Modal */}
      <Modal visible={showPaywall} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setShowPaywall(false)}>
        <View style={styles.paywallContainer}>
          <SafeAreaView style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={styles.paywallContent} bounces={false}>
              {/* Close button */}
              <TouchableOpacity style={styles.paywallCloseButton} onPress={() => setShowPaywall(false)}>
                <Text style={styles.paywallCloseText}>✕</Text>
              </TouchableOpacity>

              {/* Hero */}
              <View style={styles.paywallHero}>
                <Text style={styles.paywallLockIcon}>🔒</Text>
                <Text style={styles.paywallTitle}>SnoreAlert Premium</Text>
                <Text style={styles.paywallHeadline}>Your sleep data never{'\n'}leaves your phone.</Text>
                <Text style={styles.paywallSubheadline}>
                  All snore detection runs entirely on-device via Core ML.{'\n'}
                  No cloud. No servers. No data sharing. Ever.
                </Text>
              </View>

              {/* Feature list */}
              <View style={styles.paywallFeatures}>
                {[
                  'On-device Core ML snore detection',
                  'Unlimited sleep sessions',
                  'Apple Watch haptic alerts',
                  'Snore analytics & session history',
                  'Daily reminders',
                  'Your data stays with you — always',
                ].map((feature) => (
                  <View key={feature} style={styles.paywallFeatureRow}>
                    <Text style={styles.paywallFeatureCheck}>✓</Text>
                    <Text style={styles.paywallFeatureText}>{feature}</Text>
                  </View>
                ))}
              </View>

              {/* Pricing buttons */}
              <View style={styles.paywallPricingSection}>
                <Text style={styles.paywallTrialBadge}>3-DAY FREE TRIAL</Text>

                {/* Annual — highlighted */}
                <TouchableOpacity
                  style={[styles.paywallPriceButton, styles.paywallPriceButtonAnnual]}
                  onPress={() => purchaseSubscription(SUBSCRIPTION_SKUS.annual)}
                  disabled={isPurchasing}
                >
                  <View style={styles.paywallBestValueBadge}>
                    <Text style={styles.paywallBestValueText}>BEST VALUE</Text>
                  </View>
                  <Text style={styles.paywallPriceButtonLabel}>Annual</Text>
                  <Text style={styles.paywallPriceButtonPrice}>
                    {subscriptionProducts.find(p => p.productId.includes('annual'))?.localizedPrice ?? '$49.99'}/year
                  </Text>
                  <Text style={styles.paywallPriceButtonSub}>~$4.17/mo · Save 40%</Text>
                </TouchableOpacity>

                {/* Monthly */}
                <TouchableOpacity
                  style={styles.paywallPriceButton}
                  onPress={() => purchaseSubscription(SUBSCRIPTION_SKUS.monthly)}
                  disabled={isPurchasing}
                >
                  <Text style={styles.paywallPriceButtonLabel}>Monthly</Text>
                  <Text style={styles.paywallPriceButtonPrice}>
                    {subscriptionProducts.find(p => p.productId.includes('monthly'))?.localizedPrice ?? '$6.99'}/month
                  </Text>
                  <Text style={styles.paywallPriceButtonSub}>Billed monthly</Text>
                </TouchableOpacity>
              </View>

              {/* Restore & gift code */}
              <TouchableOpacity style={styles.paywallRestoreButton} onPress={restorePurchases} disabled={isPurchasing}>
                <Text style={styles.paywallRestoreText}>Restore Purchases</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.paywallGiftCodeButton} onPress={promptGiftCode} disabled={isPurchasing}>
                <Text style={styles.paywallGiftCodeText}>🎁 Have a gift code?</Text>
              </TouchableOpacity>

              <Text style={styles.paywallLegal}>
                Subscription auto-renews unless cancelled at least 24 hours before the end of the current period.
                Manage or cancel in Settings → Subscriptions.
              </Text>
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>

      {/* Logs Modal */}
      <Modal visible={showLogsModal} animationType="slide" onRequestClose={() => setShowLogsModal(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#1a1a2e' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#333' }}>
            <Text style={{ color: '#fff', fontSize: 18, fontWeight: 'bold' }}>App Logs</Text>
            <TouchableOpacity onPress={() => setShowLogsModal(false)}>
              <Text style={{ color: '#4a90e2', fontSize: 16 }}>Close</Text>
            </TouchableOpacity>
          </View>
          <ScrollView
            ref={logScrollViewRef}
            style={{ flex: 1, padding: 12 }}
            minimumZoomScale={1}
            maximumZoomScale={4}
            bouncesZoom={true}
            pinchGestureEnabled={true}
            contentContainerStyle={{ paddingBottom: 40 }}
            onScroll={({ nativeEvent }) => {
              const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
              logScrollAtBottomRef.current =
                contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
            }}
            scrollEventThrottle={100}
            onContentSizeChange={() => {
              if (logScrollAtBottomRef.current) {
                logScrollViewRef.current?.scrollToEnd({ animated: false });
              }
            }}
          >
            <Text style={{ color: '#ccc', fontSize: 11, fontFamily: 'Courier New', lineHeight: 18 }}>
              {logContent}
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <ScrollView contentContainerStyle={styles.homeContent}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.logoText}>SnoreAlert</Text>
            <Text style={styles.tagline}>If you snore, we will alert you</Text>
            <Text style={styles.taglineSub}>Your Partner for Better, Safer Sleep</Text>
          </View>

          {/* Status Card */}
          <View style={styles.mainCard}>
            <View style={styles.statusContainer}>
              <View style={[styles.statusDot, isMonitoring && styles.statusDotActive]} />
              <Text style={styles.statusText}>
                {isMonitoring ? '🌙 Monitoring Active' : '☁️ Ready to Monitor'}
              </Text>
            </View>

            {isMonitoring && currentAudioLevel !== null && (
              <View style={styles.liveDataCard}>
                <Text style={styles.liveDataLabel}>Current Level</Text>
                <Text style={styles.liveDataValue}>{currentAudioLevel.toFixed(1)} dB</Text>
                {lastSnoreLevel !== null && (
                  <Text style={{ fontSize: 12, color: '#ef4444', marginTop: 4 }}>
                    Last snore: {lastSnoreLevel.toFixed(1)} dB
                  </Text>
                )}
              </View>
            )}

            {/* Sensitivity Selector */}
            {!isMonitoring && (
              <View style={styles.sensitivitySection}>
                <Text style={styles.sectionLabel}>🎚️ Sensitivity Level</Text>
                <View style={styles.segmentedControl}>
                  {Object.keys(SENSITIVITY_LEVELS).map((level) => (
                    <TouchableOpacity
                      key={level}
                      style={[styles.segment, sensitivity === level && styles.activeSegment]}
                      onPress={() => setSensitivity(level)}
                    >
                      <Text style={[styles.segmentText, sensitivity === level && styles.activeSegmentText]}>
                        {level}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.sensitivityHint}>
                  {sensitivity === 'High' ? 'Catches quiet and moderate snoring (-45 dB threshold)' :
                   sensitivity === 'Medium' ? 'Clearly audible snoring only (-35 dB threshold)' :
                   'Only very loud snoring (-25 dB threshold)'}
                </Text>
              </View>
            )}

            {/* Main Action Button */}
            <TouchableOpacity
              style={[styles.mainButton, isMonitoring && styles.mainButtonStop]}
              onPress={isMonitoring ? stopMonitoring : startMonitoring}
            >
              <Text style={styles.mainButtonText}>
                {isMonitoring ? '⏹️ Stop Monitoring' : '▶️ Start Monitoring'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Last Session Summary (if available) */}
          {!isMonitoring && (
            <TouchableOpacity
              style={styles.lastSessionCard}
              onPress={() => sessionData.length > 0 && setShowAnalytics(true)}
              disabled={sessionData.length === 0}
            >
              <View style={styles.lastSessionHeader}>
                <Text style={styles.lastSessionTitle}>📊 Last Session</Text>
                <Text style={styles.lastSessionSubtitle}>
                  {sessionData.length > 0 ? 'Tap to view details' : 'No recent session to display'}
                </Text>
              </View>
              {sessionData.length > 0 ? (
                <View style={styles.lastSessionStats}>
                  <View style={styles.lastSessionStat}>
                    <Text style={styles.lastSessionStatValue}>
                      {snoreEventCount}
                    </Text>
                    <Text style={styles.lastSessionStatLabel}>Events</Text>
                  </View>
                  <View style={styles.lastSessionStat}>
                    <Text style={styles.lastSessionStatValue}>
                      {calculateSnoreScore(sessionData, SENSITIVITY_LEVELS[sensitivity], snoreEventCount)}
                    </Text>
                    <Text style={styles.lastSessionStatLabel}>Score</Text>
                  </View>
                  {sessionStartTime && sessionEndTime && (
                    <View style={styles.lastSessionStat}>
                      <Text style={styles.lastSessionStatValue}>
                        {(() => {
                          const diff = sessionEndTime - sessionStartTime;
                          const hours = Math.floor(diff / 3600000);
                          const minutes = Math.floor((diff % 3600000) / 60000);
                          return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
                        })()}
                      </Text>
                      <Text style={styles.lastSessionStatLabel}>Duration</Text>
                    </View>
                  )}
                </View>
              ) : (
                <View style={styles.lastSessionPlaceholder}>
                  <Text style={styles.lastSessionPlaceholderText}>
                    Start monitoring to record your first session
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          )}

          {/* Quick Actions */}
          <View style={styles.quickActions}>
            <TouchableOpacity style={styles.quickActionButton} onPress={viewLogs}>
              <Text style={styles.quickActionIcon}>📝</Text>
              <Text style={styles.quickActionText}>View Logs</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.quickActionButton} onPress={clearLogs}>
              <Text style={styles.quickActionIcon}>🗑️</Text>
              <Text style={styles.quickActionText}>Clear Logs</Text>
            </TouchableOpacity>
          </View>

          {/* Notification Settings */}
          {!isMonitoring && (
            <View style={styles.settingsCard}>
              <Text style={styles.settingsTitle}>Session Settings</Text>
              <View style={styles.settingRow}>
                <View style={styles.settingInfo}>
                  <Text style={styles.settingLabel}>Training Audio Capture</Text>
                  <Text style={styles.settingHint}>Save overnight microphone audio on this iPhone for model training</Text>
                </View>
                <Switch
                  value={trainingRecordingEnabled}
                  onValueChange={toggleTrainingRecording}
                  trackColor={{ false: '#767577', true: '#4a90e2' }}
                  thumbColor={trainingRecordingEnabled ? '#ffffff' : '#f4f3f4'}
                />
              </View>
              <View style={styles.settingDivider} />
              <View style={styles.settingRow}>
                <View style={styles.settingInfo}>
                  <Text style={styles.settingLabel}>Daily Evening Reminder</Text>
                  <Text style={styles.settingHint}>Get notified at 7 PM to start monitoring</Text>
                </View>
                <Switch
                  value={dailyReminderEnabled}
                  onValueChange={toggleDailyReminder}
                  trackColor={{ false: '#767577', true: '#4a90e2' }}
                  thumbColor={dailyReminderEnabled ? '#ffffff' : '#f4f3f4'}
                />
              </View>
              <Text style={styles.settingsFooter}>
                You'll receive a sleep summary immediately after each session ends.
              </Text>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#2a5298', // Solid blue background
  },
  safeArea: {
    flex: 1,
  },
  // Home Screen Styles
  homeContent: {
    padding: 20,
    paddingTop: 40,
  },
  header: {
    alignItems: 'center',
    marginBottom: 30,
  },
  logoText: {
    fontSize: 34,
    fontWeight: 'bold',
    color: '#ffffff',
    textShadowColor: 'rgba(0, 0, 0, 0.3)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 4,
  },
  tagline: {
    fontSize: 13,
    color: '#e0e9ff',
    marginTop: 6,
    fontWeight: '500',
  },
  taglineSub: {
    fontSize: 11,
    color: '#b0c4de',
    marginTop: 4,
    fontWeight: '400',
  },
  mainCard: {
    backgroundColor: '#ffffff',
    borderRadius: 24,
    padding: 24,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 5,
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#9ca3af',
    marginRight: 10,
  },
  statusDotActive: {
    backgroundColor: '#10b981',
    shadowColor: '#10b981',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 8,
  },
  statusText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#374151',
  },
  liveDataCard: {
    backgroundColor: '#f3f4f6',
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
    marginBottom: 20,
  },
  liveDataLabel: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 4,
  },
  liveDataValue: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#ef4444',
  },
  sensitivitySection: {
    marginBottom: 24,
  },
  sectionLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 12,
  },
  segmentedControl: {
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    padding: 4,
    marginBottom: 12,
  },
  segment: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 8,
  },
  activeSegment: {
    backgroundColor: '#1e3c72',
    shadowColor: '#1e3c72',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 2,
  },
  segmentText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#6b7280',
  },
  activeSegmentText: {
    color: '#ffffff',
  },
  sensitivityHint: {
    fontSize: 13,
    color: '#6b7280',
    textAlign: 'center',
    fontStyle: 'italic',
  },
  mainButton: {
    backgroundColor: '#10b981',
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    shadowColor: '#10b981',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  mainButtonStop: {
    backgroundColor: '#ef4444',
    shadowColor: '#ef4444',
  },
  mainButtonText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#ffffff',
  },
  quickActions: {
    flexDirection: 'row',
    gap: 12,
  },
  quickActionButton: {
    flex: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.3)',
  },
  quickActionIcon: {
    fontSize: 28,
    marginBottom: 8,
  },
  quickActionText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
  },
  lastSessionCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderRadius: 20,
    padding: 20,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 5,
  },
  lastSessionHeader: {
    marginBottom: 16,
  },
  lastSessionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1e3c72',
    marginBottom: 4,
  },
  lastSessionSubtitle: {
    fontSize: 13,
    color: '#6b7280',
    fontStyle: 'italic',
  },
  lastSessionStats: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  lastSessionStat: {
    alignItems: 'center',
  },
  lastSessionStatValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1e3c72',
    marginBottom: 4,
  },
  lastSessionStatLabel: {
    fontSize: 12,
    color: '#6b7280',
  },
  lastSessionPlaceholder: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  lastSessionPlaceholderText: {
    fontSize: 14,
    color: '#9ca3af',
    fontStyle: 'italic',
  },
  // Analytics Screen Styles
  analyticsContent: {
    padding: 20,
    paddingTop: 40,
  },
  analyticsHeader: {
    alignItems: 'center',
    marginBottom: 30,
  },
  analyticsTitle: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#ffffff',
    textShadowColor: 'rgba(0, 0, 0, 0.3)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 4,
  },
  analyticsDuration: {
    fontSize: 18,
    color: '#e0e9ff',
    marginTop: 8,
    fontWeight: '500',
  },
  scoreCard: {
    backgroundColor: '#ffffff',
    borderRadius: 24,
    padding: 28,
    alignItems: 'center',
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 5,
  },
  scoreLabel: {
    fontSize: 18,
    color: '#6b7280',
    marginBottom: 16,
    fontWeight: '600',
  },
  scoreCircle: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#f3f4f6',
    borderWidth: 8,
    borderColor: '#1e3c72',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  scoreValue: {
    fontSize: 48,
    fontWeight: 'bold',
    color: '#1e3c72',
  },
  scoreMax: {
    fontSize: 16,
    color: '#6b7280',
    marginTop: -8,
  },
  scoreDescription: {
    fontSize: 16,
    color: '#374151',
    fontWeight: '500',
  },
  statsGrid: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: 18,
    padding: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  statIcon: {
    fontSize: 32,
    marginBottom: 8,
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1e3c72',
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 13,
    color: '#6b7280',
    textAlign: 'center',
  },
  chartCard: {
    backgroundColor: '#ffffff',
    borderRadius: 24,
    padding: 20,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 5,
  },
  chartTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 16,
  },
  chart: {
    marginVertical: 8,
    borderRadius: 16,
  },
  backButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.3)',
  },
  backButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
  // Notification Settings Styles
  settingsCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderRadius: 24,
    padding: 20,
    marginTop: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 5,
  },
  settingsTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1e3c72',
    marginBottom: 16,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  settingInfo: {
    flex: 1,
    marginRight: 12,
  },
  settingLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 4,
  },
  settingHint: {
    fontSize: 13,
    color: '#6b7280',
  },
  settingDivider: {
    height: 1,
    backgroundColor: '#e5e7eb',
    marginBottom: 12,
  },
  settingsFooter: {
    fontSize: 13,
    color: '#6b7280',
    marginTop: 12,
    fontStyle: 'italic',
  },

  // ─── Analytics Tab Bar ────────────────────────────────────────────────────
  analyticsTabBar: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 14,
    padding: 4,
    marginBottom: 20,
  },
  analyticsTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 10,
  },
  analyticsTabActive: {
    backgroundColor: '#ffffff',
  },
  analyticsTabText: {
    fontSize: 15,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.7)',
  },
  analyticsTabTextActive: {
    color: '#1e3c72',
  },

  // ─── Playback Tab ─────────────────────────────────────────────────────────
  playbackCard: {
    backgroundColor: '#ffffff',
    borderRadius: 24,
    padding: 20,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 5,
  },
  playbackSectionLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 12,
  },
  waveformContainer: {
    height: 120,
    backgroundColor: '#0f1f3a',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 8,
    marginBottom: 4,
    overflow: 'hidden',
  },
  waveformTimeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  waveformTimeLabel: {
    fontSize: 11,
    color: '#6b7280',
    fontWeight: '500',
  },
  // Scrubber
  scrubberWrapper: {
    height: 44,
    justifyContent: 'center',
    marginBottom: 4,
  },
  scrubberTrackBg: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 4,
    backgroundColor: '#e5e7eb',
    borderRadius: 2,
  },
  scrubberFill: {
    position: 'absolute',
    left: 0,
    height: 4,
    backgroundColor: '#1e3c72',
    borderRadius: 2,
  },
  scrubberThumb: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#1e3c72',
    top: '50%',
    marginTop: -11,
    marginLeft: -11,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
  playbackTimeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
    paddingHorizontal: 2,
  },
  playbackTimeText: {
    fontSize: 13,
    color: '#6b7280',
  },
  playbackControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
    marginBottom: 20,
  },
  skipButton: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 44,
  },
  skipIcon: {
    fontSize: 22,
    color: '#1e3c72',
  },
  skipLabel: {
    fontSize: 10,
    color: '#6b7280',
    marginTop: -2,
  },
  playPauseButton: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#1e3c72',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#1e3c72',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  playPauseIcon: {
    fontSize: 24,
    color: '#ffffff',
  },
  waveformLegend: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 20,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendLine: {
    width: 20,
    height: 2,
    backgroundColor: '#10b981',
    borderRadius: 1,
  },
  legendDashedLine: {
    width: 20,
    height: 2,
    backgroundColor: '#ef4444',
    borderRadius: 1,
    opacity: 0.8,
  },
  legendText: {
    fontSize: 12,
    color: '#6b7280',
  },
  noRecordingView: {
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 16,
  },
  noRecordingIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  noRecordingTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
  },
  noRecordingText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    lineHeight: 20,
  },

  // ─── Paywall Styles ───────────────────────────────────────────────────────
  paywallContainer: {
    flex: 1,
    backgroundColor: '#1a2a5e',
  },
  paywallContent: {
    padding: 24,
    paddingBottom: 48,
  },
  paywallCloseButton: {
    alignSelf: 'flex-end',
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  paywallCloseText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  paywallHero: {
    alignItems: 'center',
    marginBottom: 28,
  },
  paywallLockIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  paywallTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#ffffff',
    marginBottom: 12,
  },
  paywallHeadline: {
    fontSize: 22,
    fontWeight: '700',
    color: '#e0e9ff',
    textAlign: 'center',
    lineHeight: 30,
    marginBottom: 12,
  },
  paywallSubheadline: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
    lineHeight: 20,
  },
  paywallFeatures: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 16,
    padding: 20,
    marginBottom: 28,
    gap: 12,
  },
  paywallFeatureRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  paywallFeatureCheck: {
    fontSize: 16,
    color: '#34d399',
    fontWeight: 'bold',
    width: 20,
  },
  paywallFeatureText: {
    fontSize: 15,
    color: '#e0e9ff',
    flex: 1,
  },
  paywallPricingSection: {
    gap: 12,
    marginBottom: 20,
  },
  paywallTrialBadge: {
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '700',
    color: '#34d399',
    letterSpacing: 1,
    marginBottom: 4,
  },
  paywallPriceButton: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 16,
    padding: 18,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  paywallPriceButtonAnnual: {
    backgroundColor: 'rgba(42,82,152,0.9)',
    borderColor: '#4a90e2',
    borderWidth: 2,
  },
  paywallBestValueBadge: {
    backgroundColor: '#34d399',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 3,
    marginBottom: 8,
  },
  paywallBestValueText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#064e3b',
    letterSpacing: 0.5,
  },
  paywallPriceButtonLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
    marginBottom: 4,
  },
  paywallPriceButtonPrice: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#ffffff',
    marginBottom: 2,
  },
  paywallPriceButtonSub: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.65)',
  },
  paywallRestoreButton: {
    alignItems: 'center',
    paddingVertical: 10,
    marginBottom: 4,
  },
  paywallRestoreText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.55)',
    textDecorationLine: 'underline',
  },
  paywallGiftCodeButton: {
    alignItems: 'center',
    paddingVertical: 10,
    marginBottom: 12,
  },
  paywallGiftCodeText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.65)',
  },
  paywallLegal: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.4)',
    textAlign: 'center',
    lineHeight: 16,
  },
});

import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View, SafeAreaView, NativeModules, Alert, ScrollView, Dimensions, AppState, TouchableOpacity, Switch, Modal } from 'react-native';
import { useState, useEffect, useRef } from 'react';
import { SnoreDetector } from './SnoreDetector';
import * as Haptics from 'expo-haptics';
import { LineChart } from 'react-native-chart-kit';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as FileSystem from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { SleepSessionBridge, NotificationBridge } = NativeModules;
const LOG_FILE = FileSystem.documentDirectory + 'app_log.txt';
const NOTIFICATION_COOLDOWN_MS = 10000; // 10 seconds between notifications
const LAST_SESSION_KEY = '@snoreguard:last_session';

// White noise machine baseline: -38 to -42 dB
// Thresholds must be above that floor to avoid false triggers
const SENSITIVITY_LEVELS = {
  High: -32,    // ~6 dB above white noise floor - catches moderate snoring
  Medium: -22,  // clearly audible snoring
  Low: -15      // only loud snoring
};

// Configure notification handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const logEvent = async (message) => {
  const timestamp = new Date().toLocaleString();
  const logEntry = `${timestamp}: ${message}\n`;
  console.log(logEntry);
  try {
    await FileSystem.writeAsStringAsync(LOG_FILE, logEntry, {
      encoding: FileSystem.EncodingType.UTF8,
      append: true,
    });
  } catch (e) {
    console.error('Failed to write log', e);
  }
};

const calculateSnoreScore = (sessionData, threshold) => {
  if (!sessionData || sessionData.length === 0) return 0;

  const snoreEvents = sessionData.filter(d => d.level > threshold);
  const avgIntensity = snoreEvents.length > 0
    ? snoreEvents.reduce((sum, d) => sum + Math.abs(d.level), 0) / snoreEvents.length
    : 0;
  const snorePercentage = (snoreEvents.length / sessionData.length) * 100;

  // Score from 0-100 (lower is better)
  return Math.min(100, Math.round((snorePercentage * 0.7) + (avgIntensity * 0.3)));
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
  const lastDataPointTimeRef = useRef(0);
  const lastLogTimeRef = useRef(0);
  const lastNotificationTimeRef = useRef(0);
  const snoreCountRef = useRef(0);
  const logScrollViewRef = useRef(null);
  const appState = useRef(AppState.currentState);

  const [showLogsModal, setShowLogsModal] = useState(false);
  const [logContent, setLogContent] = useState('');

  // Notification settings state
  const [dailyReminderEnabled, setDailyReminderEnabled] = useState(true);
  const [reminderTime, setReminderTime] = useState('19:00'); // 7 PM default
  const [isInitialLoadComplete, setIsInitialLoadComplete] = useState(false);

  useEffect(() => {
    logEvent('App mounted');

    // Request notification permissions
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
            logEvent(`Loaded previous session from storage (${data.length} points)`);
          }
        }
      } catch (e) {
        logEvent(`Failed to load session from storage: ${e.message}`);
      }

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
          logEvent(`Time since last notification: ${timeSinceLastNotif}ms (cooldown: ${NOTIFICATION_COOLDOWN_MS}ms)`);

          if (now - lastNotificationTimeRef.current >= NOTIFICATION_COOLDOWN_MS) {
            snoreCountRef.current += 1;
            setSnoreEventCount(snoreCountRef.current);

            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);

            if (NotificationBridge) {
              try {
                NotificationBridge.scheduleImmediateNotification(
                  'Snore detected',
                  'Reposition to reduce snoring.'
                );
                logEvent('Scheduled local snore notification (native)');
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
              } catch (error) {
                logEvent(`ERROR scheduling Expo notification: ${error.message || error}`);
                console.error('Expo notification error:', error);
              }
            }

            lastNotificationTimeRef.current = now;
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
      snoreDetectorRef.current.SNORE_THRESHOLD = SENSITIVITY_LEVELS[sensitivity];
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

    const syncDataFromNative = async () => {
      if (SleepSessionBridge) {
        try {
          const nativeData = await SleepSessionBridge.getNativeData();
          if (nativeData && nativeData.length > 0) {
            setSessionData(nativeData);

            const sessionStart = new Date(nativeData[0].time);
            const sessionEnd = new Date(nativeData[nativeData.length - 1].time);
            const levels = nativeData.map(d => d.level);
            const maxLevel = Math.max(...levels);
            const minLevel = Math.min(...levels);
            const snoreEvents = nativeData.filter(d => d.level > SENSITIVITY_LEVELS[sensitivity]);
            const score = calculateSnoreScore(nativeData, SENSITIVITY_LEVELS[sensitivity]);

            let logMessage = `━━━ SESSION RECOVERED ━━━\nStarted: ${sessionStart.toLocaleString()}\nEnded: ${sessionEnd.toLocaleString()}\nData points: ${nativeData.length}\nSensitivity: ${sensitivity} (${SENSITIVITY_LEVELS[sensitivity]} dB)\nAudio range: ${minLevel.toFixed(1)} to ${maxLevel.toFixed(1)} dB\n`;

            if (snoreEvents.length > 0) {
              snoreEvents.forEach(event => {
                const eventTime = new Date(event.time).toLocaleTimeString();
                const dB = Math.abs(event.level).toFixed(1);
                logMessage += `🔊 Loud snoring (${dB} dB) at ${eventTime}\n`;
              });
            } else {
              logMessage += `No events exceeded ${SENSITIVITY_LEVELS[sensitivity]} dB threshold\n`;
            }

            logMessage += `📊 ${snoreEvents.length} events detected. Score: ${score}/100`;
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
        // Don't auto-show analytics - let user tap Last Session card
        // setShowAnalytics(true);
      }
    };

    checkRecoveredSession();

    return () => {
      logEvent('App unmounting');
      subscription.remove();
      if (snoreDetectorRef.current) {
        snoreDetectorRef.current.stopMonitoring();
      }
    };
  }, []);

  useEffect(() => {
    if (snoreDetectorRef.current) {
      snoreDetectorRef.current.SNORE_THRESHOLD = SENSITIVITY_LEVELS[sensitivity];
      logEvent(`Sensitivity updated to ${sensitivity} (${SENSITIVITY_LEVELS[sensitivity]} dB)`);
    }
  }, [sensitivity]);

  const startMonitoring = async () => {
    logEvent('startMonitoring called');
    if (!snoreDetectorRef.current) return;

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
        setSnoreEventCount(0);

        // Log session start with clear separator
        const startLog = `\n${'='.repeat(50)}\n━━━ SLEEP SESSION STARTED ━━━\nTime: ${startTime.toLocaleString()}\nSensitivity: ${sensitivity} (${SENSITIVITY_LEVELS[sensitivity]} dB)`;
        await logEvent(startLog);

        await activateKeepAwakeAsync();
        keepAwakeEnabled = true;

        if (SleepSessionBridge) {
          SleepSessionBridge.clearNativeData();
          SleepSessionBridge.startSleepSession();
        }

        await snoreDetectorRef.current.startMonitoring();
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
        setIsMonitoring(false);
        setLastSnoreLevel(null);
        setCurrentAudioLevel(null);
        const endTime = new Date();
        setSessionEndTime(endTime);
        setShowAnalytics(true);

        // Build complete log message
        const snoreEvents = finalData.filter(d => d.level > SENSITIVITY_LEVELS[sensitivity]);
        const snoreCount = snoreEvents.length;
        const sessionScore = calculateSnoreScore(finalData, SENSITIVITY_LEVELS[sensitivity]);

        let logMessage = `━━━ SLEEP SESSION ENDED ━━━\nTime: ${endTime.toLocaleString()}\nData points: ${finalData.length}\nSensitivity: ${sensitivity} (${SENSITIVITY_LEVELS[sensitivity]} dB)\n`;

        if (finalData.length > 0) {
          const levels = finalData.map(d => d.level);
          const maxLevel = Math.max(...levels);
          const minLevel = Math.min(...levels);
          logMessage += `Audio range: ${minLevel.toFixed(1)} to ${maxLevel.toFixed(1)} dB\n`;
        }

        if (snoreCount > 0) {
          snoreEvents.forEach(event => {
            const eventTime = new Date(event.time).toLocaleTimeString();
            const dB = Math.abs(event.level).toFixed(1);
            logMessage += `🔊 Loud snoring (${dB} dB) at ${eventTime}\n`;
          });
        } else {
          logMessage += `No events exceeded ${SENSITIVITY_LEVELS[sensitivity]} dB threshold\n`;
        }

        const mlDetectionCount = snoreCountRef.current;
        logMessage += `📊 ${mlDetectionCount} ML detections. Score: ${sessionScore}/100\n${'='.repeat(50)}`;

        await logEvent(logMessage);

        await Notifications.scheduleNotificationAsync({
          content: {
            title: 'SnoreGuard',
            body: `Good morning! Last night: ${mlDetectionCount} snore events detected. Tap to view your sleep report.`,
            data: { type: 'summary' },
          },
          trigger: {
            seconds: 3600, // 1 hour from now
          },
        });

        // Save session to AsyncStorage for persistence across app restarts
        try {
          const lastSession = {
            data: finalData,
            startTime: sessionStartTime?.toISOString(),
            endTime: endTime.toISOString(),
            savedAt: new Date().toISOString(),
            snoreCount: snoreCountRef.current,
          };
          await AsyncStorage.setItem(LAST_SESSION_KEY, JSON.stringify(lastSession));
          logEvent('Session saved to persistent storage');
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

  const viewLogs = async () => {
    try {
      const fileInfo = await FileSystem.getInfoAsync(LOG_FILE);
      if (!fileInfo.exists) {
        Alert.alert('App Logs', 'No logs available yet.');
        return;
      }
      const content = await FileSystem.readAsStringAsync(LOG_FILE);
      if (!content || content.trim().length === 0) {
        Alert.alert('App Logs', 'No logs available yet.');
        return;
      }
      const MAX_LOG_CHARS = 30000;
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
    // Cancel any existing daily reminder
    const scheduledNotifications = await Notifications.getAllScheduledNotificationsAsync();
    for (const notification of scheduledNotifications) {
      if (notification.content.data?.type === 'daily-reminder') {
        await Notifications.cancelScheduledNotificationAsync(notification.identifier);
      }
    }

    if (!dailyReminderEnabled) {
      logEvent('Daily reminder disabled, not scheduling');
      return;
    }

    // Compute exact seconds until next occurrence to avoid iOS firing immediately
    // when the calendar trigger time has already passed today
    const [hours, minutes] = reminderTime.split(':').map(Number);
    const now = new Date();
    const next = new Date();
    next.setHours(hours, minutes, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1); // already passed today — push to tomorrow
    }
    const secondsUntilNext = Math.floor((next - now) / 1000);

    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'SnoreGuard',
        body: `🌙 Guard your sleep tonight! Make sure your iPhone and Apple Watch are charged and ready.`,
        data: { type: 'daily-reminder' },
      },
      trigger: { seconds: secondsUntilNext },
    });

    const hoursUntil = (secondsUntilNext / 3600).toFixed(1);
    logEvent(`Daily reminder scheduled for ${reminderTime} (in ${hoursUntil}h)`);
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

  // Analytics Screen
  if (showAnalytics) {
    const validSessionData = sessionData.filter(d => d.level > -100);
    const maxPoints = 50;
    let chartData = validSessionData;
    if (validSessionData.length > maxPoints) {
      const step = Math.ceil(validSessionData.length / maxPoints);
      chartData = validSessionData.filter((_, index) => index % step === 0);
    }

    // Generate labels - show start, end, and every 10th point (but skip if too close to end)
    const labels = chartData.map((d, i) => {
      const isFirst = i === 0;
      const isLast = i === chartData.length - 1;
      const isTenth = i % 10 === 0;
      const tooCloseToEnd = i >= chartData.length - 5; // Within last 5 points

      if (isFirst) {
        // Always show first label (session start)
        return new Date(d.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else if (isLast && sessionEndTime) {
        // Always show last label (session end)
        return sessionEndTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else if (isTenth && !tooCloseToEnd) {
        // Show every 10th point, but skip if too close to the end to avoid overlap
        return new Date(d.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return "";
    });

    const data = {
      labels: labels,
      datasets: [{ data: chartData.length > 0 ? chartData.map(d => d.level) : [0] }]
    };

    const snoreScore = calculateSnoreScore(sessionData, SENSITIVITY_LEVELS[sensitivity]);
    const snoreEvents = snoreEventCount;
    const avgLevel = validSessionData.length > 0
      ? (validSessionData.reduce((sum, d) => sum + d.level, 0) / validSessionData.length).toFixed(1)
      : 0;

    return (
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <StatusBar style="light" />
          <ScrollView contentContainerStyle={styles.analyticsContent}>
            <View style={styles.analyticsHeader}>
              <Text style={styles.analyticsTitle}>Sleep Session</Text>
              <Text style={styles.analyticsDuration}>{formatDuration()}</Text>
            </View>

            {/* Snore Score Card */}
            <View style={styles.scoreCard}>
              <Text style={styles.scoreLabel}>Snore Score</Text>
              <View style={styles.scoreCircle}>
                <Text style={styles.scoreValue}>{snoreScore}</Text>
                <Text style={styles.scoreMax}>/100</Text>
              </View>
              <Text style={styles.scoreDescription}>
                {snoreScore < 30 ? '😴 Excellent sleep!' :
                 snoreScore < 60 ? '😐 Moderate snoring' :
                 '😮 Heavy snoring detected'}
              </Text>
            </View>

            {/* Stats Grid */}
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

            {/* Chart Card */}
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
                  propsForDots: {
                    r: "3",
                    strokeWidth: "2",
                    stroke: "#1e3c72"
                  }
                }}
                bezier
                style={styles.chart}
              />
            </View>

            <TouchableOpacity style={styles.backButton} onPress={() => setShowAnalytics(false)}>
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
            contentContainerStyle={{ paddingBottom: 40 }}
            onContentSizeChange={() => logScrollViewRef.current?.scrollToEnd({ animated: false })}
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
            <Text style={styles.logoText}>SnoreGuard</Text>
            <Text style={styles.tagline}>Your Guardian for Safer Sleep</Text>
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
                  {sensitivity === 'High' ? 'Catches moderate snoring above white noise (-32 dB)' :
                   sensitivity === 'Medium' ? 'Clearly audible snoring only (-22 dB)' :
                   'Only loud snoring (-15 dB)'}
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
                      {calculateSnoreScore(sessionData, SENSITIVITY_LEVELS[sensitivity])}
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
              <Text style={styles.settingsTitle}>⏰ Reminders</Text>
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
                📊 You'll also receive a sleep summary 1 hour after each session ends
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
    fontSize: 42,
    fontWeight: 'bold',
    color: '#ffffff',
    textShadowColor: 'rgba(0, 0, 0, 0.3)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 4,
  },
  tagline: {
    fontSize: 16,
    color: '#e0e9ff',
    marginTop: 8,
    fontWeight: '500',
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
  settingsFooter: {
    fontSize: 13,
    color: '#6b7280',
    marginTop: 12,
    fontStyle: 'italic',
  },
});

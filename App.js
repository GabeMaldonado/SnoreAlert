import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View, SafeAreaView, NativeModules, Alert, ScrollView, Dimensions, AppState, TouchableOpacity, Switch } from 'react-native';
import { useState, useEffect, useRef } from 'react';
import { SnoreDetector } from './SnoreDetector';
import * as Haptics from 'expo-haptics';
import { LineChart } from 'react-native-chart-kit';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as FileSystem from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import * as Battery from 'expo-battery';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { WatchConnectivityBridge, SleepSessionBridge, NotificationBridge } = NativeModules;
const LOG_FILE = FileSystem.documentDirectory + 'app_log.txt';
const NOTIFICATION_COOLDOWN_MS = 10000; // 10 seconds between notifications

const SENSITIVITY_LEVELS = {
  High: -50,
  Medium: -45,
  Low: -30
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
  const [sessionData, setSessionData] = useState([]);
  const [sessionStartTime, setSessionStartTime] = useState(null);
  const [sessionEndTime, setSessionEndTime] = useState(null);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [sensitivity, setSensitivity] = useState('Medium');
  const snoreDetectorRef = useRef(null);
  const lastDataPointTimeRef = useRef(0);
  const lastLogTimeRef = useRef(0);
  const lastNotificationTimeRef = useRef(0);
  const appState = useRef(AppState.currentState);

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

      // Mark initial load as complete (this state change will trigger the scheduling useEffect)
      setIsInitialLoadComplete(true);
    })();

    const setupDetector = () => {
      snoreDetectorRef.current = new SnoreDetector(
        async (level) => {
          logEvent(`CALLBACK TRIGGERED: Snore detected at level ${level.toFixed(1)} dB`);
          setLastSnoreLevel(level);

          const now = Date.now();
          const timeSinceLastNotif = now - lastNotificationTimeRef.current;
          logEvent(`Time since last notification: ${timeSinceLastNotif}ms (cooldown: ${NOTIFICATION_COOLDOWN_MS}ms)`);

          if (now - lastNotificationTimeRef.current >= NOTIFICATION_COOLDOWN_MS) {
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

            if (WatchConnectivityBridge) {
              try {
                WatchConnectivityBridge.sendVibrateCommand();
                logEvent(`Sent vibrate command to Watch (Level: ${level.toFixed(1)})`);
              } catch (error) {
                logEvent(`ERROR sending watch vibrate: ${error.message || error}`);
                console.error('Watch vibrate error:', error);
              }
            } else {
              logEvent('WARNING: WatchConnectivityBridge is not available');
            }

            lastNotificationTimeRef.current = now;
          }
        },
        (level) => {
          const now = Date.now();
          if (now - lastLogTimeRef.current >= 10000) {
            logEvent(`Audio Level: ${level.toFixed(1)} dB`);
            lastLogTimeRef.current = now;
          }

          if (now - lastDataPointTimeRef.current >= 5000) {
            const newDataPoint = { time: new Date().toISOString(), level: level };
            setSessionData(prev => [...prev, newDataPoint]);
            if (SleepSessionBridge) {
              SleepSessionBridge.logDataPoint(newDataPoint);
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
            logEvent(`Synced ${nativeData.length} points from native storage`);
          }
          return nativeData || [];
        } catch (e) {
          logEvent(`Failed to sync native data: ${e.message}`);
        }
      }
      return [];
    };

    const checkRecoveredSession = async () => {
      const recoveredData = await syncDataFromNative();
      if (recoveredData.length > 0) {
        setSessionStartTime(new Date(recoveredData[0].time));
        setSessionEndTime(new Date(recoveredData[recoveredData.length - 1].time));
        setShowAnalytics(true);
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

        setSessionData([]);
        setSessionStartTime(new Date());
        setSessionEndTime(null);
        setShowAnalytics(false);
        lastDataPointTimeRef.current = 0;
        lastLogTimeRef.current = 0;
        lastNotificationTimeRef.current = 0;

        await activateKeepAwakeAsync();
        keepAwakeEnabled = true;

        if (SleepSessionBridge) {
          SleepSessionBridge.clearNativeData();
          SleepSessionBridge.startSleepSession();
        }

        if (WatchConnectivityBridge?.startWatchSession) {
          WatchConnectivityBridge.startWatchSession();
          logEvent('Requested Watch session start');
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
        if (WatchConnectivityBridge?.stopWatchSession) {
          WatchConnectivityBridge.stopWatchSession();
          logEvent('Requested Watch session stop');
        }
        setIsMonitoring(false);
        setLastSnoreLevel(null);
        const endTime = new Date();
        setSessionEndTime(endTime);
        setShowAnalytics(true);

        // Schedule summary notification 1 hour after session ends
        const snoreEvents = finalData.filter(d => d.level > SENSITIVITY_LEVELS[sensitivity]);
        const snoreCount = snoreEvents.length;
        await Notifications.scheduleNotificationAsync({
          content: {
            title: 'SnoreGuard',
            body: `Good morning! Last night: ${snoreCount} snore events detected. Tap to view your sleep report.`,
            data: { type: 'summary' },
          },
          trigger: {
            seconds: 3600, // 1 hour from now
          },
        });
        logEvent(`Scheduled summary notification for 1 hour (${snoreCount} events)`);
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
        Alert.alert('App Logs', 'No logs available yet. Logs will appear after monitoring sessions.');
        return;
      }
      const content = await FileSystem.readAsStringAsync(LOG_FILE);
      if (!content || content.trim().length === 0) {
        Alert.alert('App Logs', 'No logs available yet. Logs will appear after monitoring sessions.');
        return;
      }
      // Show last 2000 characters to avoid display issues
      const displayContent = content.length > 2000 ? '...\n' + content.slice(-2000) : content;
      Alert.alert('App Logs', displayContent);
    } catch (e) {
      console.error('Error reading logs:', e);
      Alert.alert('Error', `Failed to read logs: ${e.message}`);
    }
  };

  const clearLogs = async () => {
    try {
      await FileSystem.deleteAsync(LOG_FILE, { idempotent: true });
      Alert.alert('Success', 'Logs cleared');
      logEvent('Logs cleared manually');
    } catch (e) {
      Alert.alert('Error', 'Failed to clear logs');
    }
  };

  // Notification helper functions
  const scheduleDailyReminder = async () => {
    // Cancel only daily reminder notifications (not all notifications)
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

    // Parse reminder time (format: "19:00")
    const [hours, minutes] = reminderTime.split(':').map(Number);

    // Schedule daily repeating notification using calendar trigger
    // This will fire every day at the specified time, not immediately
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'SnoreGuard',
        body: `🌙 Guard your sleep tonight! Make sure your iPhone and Apple Watch are charged and ready.`,
        data: { type: 'daily-reminder' },
      },
      trigger: {
        hour: hours,
        minute: minutes,
        repeats: true,
      },
    });

    logEvent(`Daily reminder scheduled for ${reminderTime}`);
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

  // Schedule daily reminder when TIME changes or after initial load
  // Don't reschedule when just toggling on/off - this prevents the notification banner from appearing
  useEffect(() => {
    if (isInitialLoadComplete) {
      scheduleDailyReminder();
    }
  }, [reminderTime, isInitialLoadComplete]);

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
    const maxPoints = 50;
    let chartData = sessionData;
    if (sessionData.length > maxPoints) {
      const step = Math.ceil(sessionData.length / maxPoints);
      chartData = sessionData.filter((_, index) => index % step === 0);
    }

    const data = {
      labels: chartData.map((d, i) => (i % 10 === 0 ? new Date(d.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "")),
      datasets: [{ data: chartData.length > 0 ? chartData.map(d => d.level) : [0] }]
    };

    const snoreScore = calculateSnoreScore(sessionData, SENSITIVITY_LEVELS[sensitivity]);
    const snoreEvents = sessionData.filter(d => d.level > SENSITIVITY_LEVELS[sensitivity]).length;
    const avgLevel = sessionData.length > 0
      ? (sessionData.reduce((sum, d) => sum + Math.abs(d.level), 0) / sessionData.length).toFixed(1)
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

            {isMonitoring && lastSnoreLevel !== null && (
              <View style={styles.liveDataCard}>
                <Text style={styles.liveDataLabel}>Current Level</Text>
                <Text style={styles.liveDataValue}>{lastSnoreLevel.toFixed(1)} dB</Text>
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
                  {sensitivity === 'High' ? 'Most sensitive - detects quiet sounds' :
                   sensitivity === 'Medium' ? 'Balanced - recommended for most users' :
                   'Least sensitive - only loud snoring'}
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

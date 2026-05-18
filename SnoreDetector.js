import { Audio } from 'expo-av';
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { NativeAudioRecorder } = NativeModules;
// Use native recorder on iOS - runs on a native thread, works when phone is locked
const useNativeRecorder = Platform.OS === 'ios' && !!NativeAudioRecorder;

export class SnoreDetector {
    constructor(onSnoreDetected, onLevelUpdate) {
        this.onSnoreDetected = onSnoreDetected;
        this.onLevelUpdate = onLevelUpdate;
        this.recording = null;
        this.isMonitoring = false;
        this.SNORE_THRESHOLD = -40;
        this.useNative = useNativeRecorder;
        this.nativeEmitter = this.useNative ? new NativeEventEmitter(NativeAudioRecorder) : null;
        this.nativeLevelSub = null;
        this.nativeErrorSub = null;
        this.lastStatusUpdateAt = 0;
        this.restartTimer = null;
        this.watchdogTimer = null;
        this.isRestarting = false;
        this.recordingRestartIntervalMs = 15 * 60 * 1000; // 15 minutes
        this.statusStallThresholdMs = 20000; // 20 seconds without status update
        this.recordTrainingAudio = false;
        this.lastTrainingRecordingPath = null;
    }

    async requestPermissions() {
        if (this.useNative) {
            console.log('Using native audio recorder (permissions handled by iOS)');
            return true;
        }
        console.log('Requesting audio permissions for expo-av');
        const { status } = await Audio.requestPermissionsAsync();
        console.log('Audio permission status:', status);
        return status === 'granted';
    }

    setTrainingRecordingEnabled(enabled) {
        this.recordTrainingAudio = !!enabled;
    }

    getLastTrainingRecordingPath() {
        return this.lastTrainingRecordingPath;
    }

    async startMonitoring() {
        if (this.isMonitoring) return;

        try {
            if (this.useNative) {
                try {
                    this.subscribeNativeEvents();
                    await NativeAudioRecorder.start({
                        saveTrainingRecording: this.recordTrainingAudio,
                    });
                    this.isMonitoring = true;
                    console.log('Snore monitoring started (native)');
                    return;
                } catch (nativeError) {
                    console.warn('Native recorder failed, falling back to expo-av:', nativeError);
                    this.useNative = false; // Disable native for this session
                    this.unsubscribeNativeEvents();
                }
            }

            // Fallback to expo-av
            await this.ensureRecordingActive();
            this.isMonitoring = true;
            this.startTimers();
            console.log('Snore monitoring started (expo-av)');

        } catch (error) {
            console.error('Failed to start recording', error);
            this.isMonitoring = false;
            this.recording = null;
            throw error;
        }
    }

    async stopMonitoring() {
        if (!this.isMonitoring) return;

        try {
            if (this.useNative) {
                const result = await NativeAudioRecorder.stop();
                this.lastTrainingRecordingPath = result?.trainingRecordingPath || this.lastTrainingRecordingPath;
                this.unsubscribeNativeEvents();
                this.isMonitoring = false;
                console.log('Snore monitoring stopped (native)');
                return;
            }
            this.stopTimers();
            if (this.recording) {
                await this.recording.stopAndUnloadAsync();
                this.recording = null;
            }
            this.isMonitoring = false;
            console.log('Snore monitoring stopped');
        } catch (error) {
            console.error('Failed to stop recording', error);
            this.recording = null;
            this.isMonitoring = false;
        }
    }

    onStatusUpdate(status) {
        this.lastStatusUpdateAt = Date.now();
        if (status.isRecording && status.metering !== undefined) {
            const currentLevel = status.metering;
            const mlConfidence = status.mlSnoreConfidence;
            const mlActive = status.mlActive === true;

            if (this.onLevelUpdate) {
                this.onLevelUpdate(currentLevel);
            }

            // ML path: require audio above a sensitivity-scaled floor so High/Medium/Low
            // settings actually affect ML firing (gate is SNORE_THRESHOLD - 15 dB, giving
            // High=-60, Medium=-50, Low=-40 — softer than the dB path but not ungated).
            const mlPowerGate = this.SNORE_THRESHOLD - 15;
            const isSnoreEvent = mlActive
                ? mlConfidence !== undefined && currentLevel > mlPowerGate
                : currentLevel > this.SNORE_THRESHOLD;

            if (isSnoreEvent) {
                if (this.onSnoreDetected) {
                    this.onSnoreDetected(currentLevel, mlConfidence);
                }
            }
        }
    }

    subscribeNativeEvents() {
        if (!this.nativeEmitter) return;
        if (!this.nativeLevelSub) {
            this.nativeLevelSub = this.nativeEmitter.addListener('NativeAudioLevel', (event) => {
                const level = event?.level;
                if (typeof level === 'number') {
                    this.onStatusUpdate({
                        isRecording: true,
                        metering: level,
                        mlActive: event?.mlActive,
                        mlSnoreConfidence: event?.mlSnoreConfidence,
                    });
                    if (event?.trainingRecordingPath) {
                        this.lastTrainingRecordingPath = event.trainingRecordingPath;
                    }
                }
            });
        }
        if (!this.nativeErrorSub) {
            this.nativeErrorSub = this.nativeEmitter.addListener('NativeAudioError', (event) => {
                console.error('Native audio error', event?.message);
            });
        }
    }

    unsubscribeNativeEvents() {
        if (this.nativeLevelSub) {
            this.nativeLevelSub.remove();
            this.nativeLevelSub = null;
        }
        if (this.nativeErrorSub) {
            this.nativeErrorSub.remove();
            this.nativeErrorSub = null;
        }
    }

    startTimers() {
        this.stopTimers();
        this.restartTimer = setInterval(() => {
            this.restartRecording("periodic");
        }, this.recordingRestartIntervalMs);

        this.watchdogTimer = setInterval(() => {
            if (!this.isMonitoring) return;
            const now = Date.now();
            if (this.lastStatusUpdateAt === 0 || now - this.lastStatusUpdateAt > this.statusStallThresholdMs) {
                this.restartRecording("watchdog");
            }
        }, 5000);
    }

    stopTimers() {
        if (this.restartTimer) {
            clearInterval(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
    }

    async restartRecording(reason) {
        if (!this.isMonitoring || this.isRestarting) return;
        this.isRestarting = true;
        try {
            console.log(`Restarting recording (${reason})`);
            if (this.recording) {
                try {
                    await this.recording.stopAndUnloadAsync();
                } catch (e) {
                    console.log('Error stopping recording during restart:', e);
                }
                this.recording = null;
            }
            await this.ensureRecordingActive();
        } catch (e) {
            console.error('Failed to restart recording', e);
        } finally {
            this.isRestarting = false;
        }
    }

    async ensureRecordingActive() {
        if (this.recording) return;

        await Audio.setAudioModeAsync({
            allowsRecordingIOS: true,
            playsInSilentModeIOS: true,
            staysActiveInBackground: true,
            interruptionModeIOS: 1, // MixWithOthers
            shouldDuckAndroid: true,
            playThroughEarpieceAndroid: false,
        });

        this.recording = new Audio.Recording();

        await this.recording.prepareToRecordAsync({
            isMeteringEnabled: true,
            android: {
                extension: '.m4a',
                outputFormat: Audio.RECORDING_OPTION_ANDROID_OUTPUT_FORMAT_MPEG_4,
                audioEncoder: Audio.RECORDING_OPTION_ANDROID_AUDIO_ENCODER_AAC,
                sampleRate: 44100,
                numberOfChannels: 2,
                bitRate: 128000,
            },
            ios: {
                extension: '.m4a',
                outputFormat: Audio.RECORDING_OPTION_IOS_OUTPUT_FORMAT_MPEG4AAC,
                audioQuality: Audio.RECORDING_OPTION_IOS_AUDIO_QUALITY_HIGH,
                sampleRate: 44100,
                numberOfChannels: 2,
                bitRate: 128000,
                linearPCMBitDepth: 16,
                linearPCMIsBigEndian: false,
                linearPCMIsFloat: false,
            },
            web: {
                mimeType: 'audio/webm',
                bitsPerSecond: 128000,
            },
        });

        this.recording.setOnRecordingStatusUpdate(this.onStatusUpdate.bind(this));
        await this.recording.startAsync();
        this.lastStatusUpdateAt = Date.now();
    }
}

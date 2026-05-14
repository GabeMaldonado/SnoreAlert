import SwiftUI

// MARK: - ContentView

struct ContentView: View {
    @EnvironmentObject private var hapticManager: HapticManager
    @EnvironmentObject private var runtimeManager: ExtendedRuntimeManager
    @EnvironmentObject private var connectivityManager: WatchConnectivityManager

    // Drives the repeating glow pulse on the aura orb
    @State private var pulsing = false
    // Stays true for 30 s after an alert fires so the user sees the alert state
    @State private var showAlertUI = false
    // Drives the shockwave rings that expand outward during an alert
    @State private var shockwavePhase: CGFloat = 0

    var body: some View {
        ZStack {
            background
            VStack(spacing: 0) {
                Spacer(minLength: 4)
                auraOrb
                Spacer(minLength: 8)
                labelBlock
                Spacer(minLength: 6)
                statusCapsule
                Spacer(minLength: 4)
            }
            .padding(.horizontal, 8)
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
                pulsing = true
            }
        }
        .onChange(of: hapticManager.isPlayingAlert) { isPlaying in
            if isPlaying {
                showAlertUI = true
                triggerShockwave()
            } else if showAlertUI {
                Task {
                    try? await Task.sleep(nanoseconds: 30_000_000_000)
                    showAlertUI = false
                }
            }
        }
    }

    // MARK: - State helpers

    private var isAlert:     Bool { showAlertUI || hapticManager.isPlayingAlert }
    private var isMonitor:   Bool { connectivityManager.isMonitoring }
    private var isConnected: Bool { connectivityManager.isSessionActivated }
    private var shouldPulse: Bool { isMonitor || isAlert }

    private var accent: Color {
        if isAlert     { return Color(red: 0.94, green: 0.27, blue: 0.27) }
        if isMonitor   { return Color(red: 0.20, green: 0.83, blue: 0.60) }
        if isConnected { return Color(red: 0.40, green: 0.70, blue: 1.00) }
        return Color(white: 0.38)
    }

    // MARK: - Sub-views

    private var background: some View {
        LinearGradient(
            colors: [
                Color(red: 0.06, green: 0.10, blue: 0.22),
                Color(red: 0.10, green: 0.20, blue: 0.38)
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .ignoresSafeArea()
    }

    // Central aura orb — concentric layers that breathe when active
    private var auraOrb: some View {
        ZStack {
            // Shockwave rings — only visible during alert
            if isAlert {
                ForEach(0..<3, id: \.self) { i in
                    ShockwaveRing(accent: accent, index: i, phase: shockwavePhase)
                }
            }

            // Outermost diffuse glow — slow breathe when monitoring
            Circle()
                .fill(accent.opacity(0.14))
                .frame(width: 100, height: 100)
                .scaleEffect(shouldPulse ? (pulsing ? 1.18 : 0.90) : 1.0)
                .opacity(shouldPulse ? 1.0 : 0.0)
                .animation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true), value: pulsing)

            // Mid glow ring
            Circle()
                .fill(accent.opacity(0.22))
                .frame(width: 82, height: 82)
                .scaleEffect(shouldPulse ? (pulsing ? 1.10 : 0.94) : 1.0)
                .animation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true).delay(0.15), value: pulsing)

            // Solid orb core with subtle radial gradient for depth
            Circle()
                .fill(
                    RadialGradient(
                        colors: [accent.opacity(0.38), accent.opacity(0.16)],
                        center: .center,
                        startRadius: 0,
                        endRadius: 34
                    )
                )
                .frame(width: 68, height: 68)
                .overlay(
                    Circle()
                        .stroke(accent.opacity(0.80), lineWidth: 1.5)
                )
                // Subtle inner specular highlight (visionOS-inspired glassy feel)
                .overlay(
                    Ellipse()
                        .fill(Color.white.opacity(0.12))
                        .frame(width: 32, height: 14)
                        .offset(y: -14)
                        .blendMode(.screen)
                )

            // State icon
            Image(systemName: stateIcon)
                .font(.system(size: 26, weight: .medium))
                .foregroundStyle(accent)
                .symbolRenderingMode(.hierarchical)
                // Alert icon gets a hard scale-up pulse
                .scaleEffect(isAlert ? (pulsing ? 1.12 : 0.96) : 1.0)
                .animation(.easeInOut(duration: 0.55).repeatForever(autoreverses: true), value: pulsing)
        }
        .frame(height: 108)
    }

    private var stateIcon: String {
        if isAlert     { return "exclamationmark.triangle.fill" }
        if isMonitor   { return "moon.zzz.fill" }
        if isConnected { return "iphone.radiowaves.left.and.right" }
        return "iphone.slash"
    }

    // Primary + secondary labels
    private var labelBlock: some View {
        VStack(spacing: 4) {
            Text(primaryLabel)
                .font(.system(size: isAlert ? 19 : 17, weight: .bold, design: .rounded))
                .foregroundStyle(isAlert ? accent : .white)
                .multilineTextAlignment(.center)
                // Subtle flash on alert entry
                .opacity(isAlert ? (pulsing ? 1.0 : 0.72) : 1.0)
                .animation(.easeInOut(duration: 0.55).repeatForever(autoreverses: true), value: pulsing)

            Text(secondaryLabel)
                .font(.system(size: 13, weight: isAlert ? .semibold : .regular, design: .rounded))
                .foregroundStyle(Color.white.opacity(isAlert ? 0.90 : 0.65))
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var primaryLabel: String {
        if isAlert     { return "Snore Detected" }
        if isMonitor   { return "Monitoring" }
        if isConnected { return "Ready" }
        return "Not Connected"
    }

    private var secondaryLabel: String {
        if isAlert     { return "Reposition for\nbetter sleep" }
        if isMonitor   { return "Wrist alert armed" }
        if isConnected { return "Start on your iPhone" }
        return "Open SnoreAlert\non iPhone"
    }

    // Bottom capsule — connection dot + label
    private var statusCapsule: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(isConnected ? accent : Color.white.opacity(0.20))
                .frame(width: 5, height: 5)
                .shadow(color: isConnected ? accent.opacity(0.80) : .clear, radius: 3)
            Text(capsuleLabel)
                .font(.system(size: 11, weight: .regular, design: .rounded))
                .foregroundStyle(Color.white.opacity(0.52))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
            Capsule()
                .fill(Color.white.opacity(0.07))
                .overlay(
                    Capsule()
                        .stroke(Color.white.opacity(0.10), lineWidth: 0.5)
                )
        )
    }

    private var capsuleLabel: String {
        if isMonitor   { return "iPhone connected" }
        if isConnected { return "iPhone paired" }
        return "Searching for iPhone…"
    }

    // MARK: - Shockwave helpers

    private func triggerShockwave() {
        shockwavePhase = 0
        withAnimation(.easeOut(duration: 1.2)) {
            shockwavePhase = 1
        }
    }
}

// MARK: - Shockwave Ring

/// A single expanding ring that fades out — three staggered instances create the ripple effect.
private struct ShockwaveRing: View {
    let accent: Color
    let index: Int
    let phase: CGFloat  // 0 → 1 driven by the parent animation

    // Each ring starts slightly after the previous one
    private var delay: Double { Double(index) * 0.22 }
    private var progress: CGFloat { max(0, min(1, phase - CGFloat(delay))) }

    var body: some View {
        Circle()
            .stroke(accent.opacity(Double((1 - progress) * 0.60)), lineWidth: 1.5)
            .frame(width: 68, height: 68)
            .scaleEffect(1.0 + progress * CGFloat(1.10 + Double(index) * 0.22))
            .opacity(Double(1 - progress))
    }
}

// MARK: - Preview

#Preview("Not Connected") {
    let haptic = HapticManager()
    let runtime = ExtendedRuntimeManager()
    let connectivity = WatchConnectivityManager(hapticManager: haptic, runtimeManager: runtime)

    return ContentView()
        .environmentObject(haptic)
        .environmentObject(runtime)
        .environmentObject(connectivity)
}

#Preview("Monitoring") {
    let haptic = HapticManager()
    let runtime = ExtendedRuntimeManager()
    let connectivity = WatchConnectivityManager(hapticManager: haptic, runtimeManager: runtime)

    return ContentView()
        .environmentObject(haptic)
        .environmentObject(runtime)
        .environmentObject(connectivity)
}

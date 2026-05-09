import SwiftUI

struct ContentView: View {
  @EnvironmentObject private var hapticManager: HapticManager
  @EnvironmentObject private var runtimeManager: ExtendedRuntimeManager
  @EnvironmentObject private var connectivityManager: WatchConnectivityManager

  var body: some View {
    ZStack {
      LinearGradient(
        colors: [
          Color(red: 0.08, green: 0.13, blue: 0.26),
          Color(red: 0.12, green: 0.23, blue: 0.43)
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
      .ignoresSafeArea()

      ScrollView(showsIndicators: false) {
        VStack(spacing: 10) {
          Text("SnoreGuard")
            .font(.headline.weight(.semibold))
            .foregroundStyle(.white)

          VStack(spacing: 10) {
            ZStack {
              Circle()
                .fill(statusAccent.opacity(0.18))
                .frame(width: 42, height: 42)

              Circle()
                .fill(statusAccent)
                .frame(width: 14, height: 14)
            }

            VStack(spacing: 3) {
              Text(primaryStatus)
                .font(.subheadline.weight(.semibold))
                .multilineTextAlignment(.center)
                .foregroundStyle(.white)

              Text(secondaryStatus)
                .font(.caption2)
                .multilineTextAlignment(.center)
                .foregroundStyle(Color.white.opacity(0.72))
            }

            if let detail = detailStatus {
              Text(detail)
                .font(.caption2)
                .foregroundStyle(Color.white.opacity(0.64))
                .multilineTextAlignment(.center)
            }
          }
          .frame(maxWidth: .infinity)
          .padding(.horizontal, 12)
          .padding(.vertical, 14)
          .background(panelBackground)

          Button {
            runtimeManager.startIfNeeded()
            hapticManager.playSnoreAlert()
          } label: {
            Text("Test Haptics")
              .font(.caption.weight(.semibold))
              .frame(maxWidth: .infinity)
              .padding(.vertical, 9)
          }
          .buttonStyle(.plain)
          .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
              .fill(Color.white.opacity(0.10))
          )
          .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
              .stroke(Color.white.opacity(0.10), lineWidth: 1)
          )
          .foregroundStyle(.white)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
      }
    }
  }

  private var primaryStatus: String {
    if connectivityManager.isMonitoring && connectivityManager.activationStateText.contains("Activated") {
      return "Ready to Monitor"
    }

    if connectivityManager.activationStateText.contains("Activated") {
      return "Connected to iPhone"
    }

    if connectivityManager.activationStateText.contains("Activating") {
      return "Connecting"
    }

    return "Waiting for iPhone"
  }

  private var secondaryStatus: String {
    if connectivityManager.isMonitoring {
      return "The watch is armed and waiting for snore alerts."
    }

    if connectivityManager.activationStateText.contains("Activated") {
      return "Open SnoreGuard on your phone to start monitoring."
    }

    return "Keep the phone nearby while the connection wakes up."
  }

  private var detailStatus: String? {
    if hapticManager.isPlayingAlert {
      return "Playing alert"
    }

    if runtimeManager.isRunning {
      return "Extended runtime active"
    }

    return connectivityManager.lastMessage == "Waiting for iPhone" ? nil : connectivityManager.lastMessage
  }

  private var statusAccent: Color {
    connectivityManager.isMonitoring ? Color(red: 0.20, green: 0.83, blue: 0.60) : Color(red: 0.30, green: 0.60, blue: 1.00)
  }

  private var panelBackground: some View {
    RoundedRectangle(cornerRadius: 22, style: .continuous)
      .fill(Color.white.opacity(0.10))
      .overlay(
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .stroke(Color.white.opacity(0.10), lineWidth: 1)
      )
  }
}

#Preview {
  let hapticManager = HapticManager()
  let runtimeManager = ExtendedRuntimeManager()
  let connectivityManager = WatchConnectivityManager(hapticManager: hapticManager, runtimeManager: runtimeManager)

  return ContentView()
    .environmentObject(hapticManager)
    .environmentObject(runtimeManager)
    .environmentObject(connectivityManager)
}

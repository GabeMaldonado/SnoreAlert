     1→import SwiftUI
     2→import WatchKit
     3→
     4→struct ContentView: View {
     5→    @ObservedObject var connectivityManager = WatchConnectivityManager.shared
     6→    @ObservedObject var runtimeManager = ExtendedRuntimeManager.shared
     7→    
     8→    var body: some View {
     9→        ScrollView {
    10→            VStack(spacing: 16) {
    11→                // Header
    12→                Text("SnoreGuard")
    13→                    .font(.headline)
    14→                    .foregroundColor(.blue)
    15→                    .padding(.top, 8)
    16→                
    17→                // Status Indicator
    18→                HStack(spacing: 8) {
    19→                    Circle()
    20→                        .fill(connectivityManager.isConnected ? Color.green : Color.red)
    21→                        .frame(width: 10, height: 10)
    22→                        .shadow(color: connectivityManager.isConnected ? .green.opacity(0.5) : .clear, radius: 4)
    23→                    
    24→                    Text(connectivityManager.isConnected ? "Connected" : "Disconnected")
    25→                        .font(.subheadline)
    26→                        .fontWeight(.medium)
    27→                        .foregroundColor(connectivityManager.isConnected ? .primary : .secondary)
    28→                }
    29→                .padding(.vertical, 4)
    30→                .padding(.horizontal, 12)
    31→                .background(Color.gray.opacity(0.15))
    32→                .cornerRadius(20)
    33→                
    34→                Divider()
    35→                    .padding(.horizontal)
    36→                
    37→                // Session Control
    38→                Button(action: {
    39→                    if runtimeManager.isSessionRunning {
    40→                        runtimeManager.stopSession()
    41→                    } else {
    42→                        runtimeManager.startSession(autoRestart: true)
    43→                    }
    44→                }) {
    45→                    Text(runtimeManager.isSessionRunning ? "Stop Sleep Mode" : "Start Sleep Mode")
    46→                        .fontWeight(.bold)
    47→                        .foregroundColor(.white)
    48→                }
    49→                .background(runtimeManager.isSessionRunning ? Color.red : Color.blue)
    50→                .cornerRadius(22)
    51→                
    52→                if runtimeManager.isSessionRunning {
    53→                    Text("Monitoring Active")
    54→                        .font(.caption)
    55→                        .foregroundColor(.green)
    56→                        .padding(.top, 4)
    57→                }
    58→                
    59→                Divider()
    60→                    .padding(.horizontal)
    61→                
    62→                // Last Message
    63→                VStack(spacing: 4) {
    64→                    Text("Last Event")
    65→                        .font(.caption2)
    66→                        .textCase(.uppercase)
    67→                        .foregroundColor(.secondary)
    68→                    
    69→                    Text(connectivityManager.lastMessageReceived)
    70→                        .font(.body)
    71→                        .fontWeight(.medium)
    72→                        .multilineTextAlignment(.center)
    73→                        .padding(.horizontal)
    74→                }
    75→                
    76→                Spacer()
    77→            }
    78→            .padding()
    79→        }
    80→    }
    81→}
    82→
    83→struct ContentView_Previews: PreviewProvider {
    84→    static var previews: some View {
    85→        ContentView()
    86→    }
    87→}
    88→

<system-reminder>
Whenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior.
</system-reminder>

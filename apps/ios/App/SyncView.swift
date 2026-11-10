import SwiftUI
import TaskMasterKit

/// Connects the phone to a task-master server, step by step, then shows how sync is doing.
struct SyncView: View {
    let sync: SyncModel
    @State private var address = ""
    @State private var token = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                switch sync.step {
                case .address:
                    Section {
                        TextField("tasks.example.org", text: $address)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .accessibilityIdentifier("serverAddress")
                        Button("Connect") { Task { await sync.connect(address) } }
                            .disabled(address.isEmpty || sync.busy)
                    } header: {
                        Text("Server")
                    } footer: {
                        Text("The address of your task-master server. Your tasks stay on this phone and sync in the background.")
                    }
                case .token:
                    server
                    Section {
                        SecureField("Token", text: $token)
                            .accessibilityIdentifier("serverToken")
                        Button("Save token") { Task { await sync.setToken(token) } }
                            .disabled(token.isEmpty || sync.busy)
                    } footer: {
                        Text("Make one on the server: task-master-server token add <name>")
                    }
                case .signIn:
                    server
                    Section {
                        Text("This server signs in with an identity provider. Sign-in on the phone is not built yet; use a server token for now.")
                            .foregroundStyle(.secondary)
                    }
                case .join:
                    server
                    Section {
                        Button("Merge with this phone's tasks") { Task { await sync.join(.merge) } }
                        Button("Replace this phone's tasks", role: .destructive) {
                            Task { await sync.join(.replace) }
                        }
                    } header: {
                        Text("Start syncing")
                    } footer: {
                        Text(
                            sync.status.serverEmpty == true
                                ? "The server is empty: this phone's tasks will be uploaded."
                                : "Merge keeps both. Replace backs up this phone's tasks, then takes the server's.")
                    }
                    .disabled(sync.busy)
                case .syncing:
                    server
                    Section("Status") {
                        LabeledContent("State", value: stateText)
                        LabeledContent("Waiting to upload", value: "\(sync.status.pending)")
                        if let at = sync.status.lastSyncAt {
                            LabeledContent("Last sync") {
                                Text(Date(timeIntervalSince1970: Double(at) / 1000), style: .relative)
                            }
                        }
                        if sync.status.clockWarning {
                            Label("This phone's clock is more than a minute off.", systemImage: "clock.badge.exclamationmark")
                        }
                    }
                    Section {
                        Button("Sync now") { Task { await sync.syncNow() } }
                            .disabled(sync.busy)
                    }
                }

                if let error = sync.error ?? sync.status.lastError {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("syncError")
                    }
                }
            }
            .navigationTitle("Sync")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                if sync.busy {
                    ToolbarItem(placement: .topBarLeading) { ProgressView() }
                }
            }
        }
    }

    private var server: some View {
        Section("Server") {
            LabeledContent("Address", value: sync.status.url)
            Button("Disconnect", role: .destructive) { Task { await sync.disconnect() } }
                .disabled(sync.busy)
        }
    }

    private var stateText: String {
        if sync.status.syncing { return "Syncing" }
        return sync.status.lastError == nil ? "Up to date" : "Last round failed"
    }
}

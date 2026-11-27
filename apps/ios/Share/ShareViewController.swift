import SwiftUI
import TaskMasterKit
import UIKit
import UniformTypeIdentifiers

/// "Task Master" in the share sheet (docs/ios-plan.md P5): a link, text or images from any
/// app become a task in the Inbox. The title is editable before adding; a link goes into
/// the description, images are attached. Writes the shared database and leaves; the app
/// picks it up when it next comes to the front, and syncs it.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let model = ShareModel(items: extensionContext?.inputItems as? [NSExtensionItem] ?? [])
        model.finish = { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        Task { await model.load() }
    }
}

@MainActor
@Observable
final class ShareModel {
    var title = ""
    var link: URL?
    var text = ""
    var images: [URL] = []
    var error: String?
    var busy = true
    @ObservationIgnored var finish: () -> Void = {}
    @ObservationIgnored private let items: [NSExtensionItem]

    init(items: [NSExtensionItem]) { self.items = items }

    /// Reads what was shared: the first link, the text, and image files (copied, since
    /// the provider's files vanish when the extension ends).
    func load() async {
        defer { busy = false }
        for item in items {
            if title.isEmpty, let name = item.attributedContentText?.string, !name.isEmpty { title = name }
            for provider in item.attachments ?? [] {
                if link == nil, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                    let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL
                {
                    link = url
                } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier),
                    let file = await copy(provider)
                {
                    images.append(file)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                    let shared = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String
                {
                    text += (text.isEmpty ? "" : "\n") + shared
                }
            }
        }
        if title.isEmpty {
            title = text.split(separator: "\n").first.map(String.init) ?? link?.host() ?? (images.isEmpty ? "" : "Photo")
        }
    }

    private func copy(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { done in
            provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
                guard let url else { return done.resume(returning: nil) }
                let target = FileManager.default.temporaryDirectory
                    .appendingPathComponent(UUID().uuidString + "-" + url.lastPathComponent)
                done.resume(returning: (try? FileManager.default.copyItem(at: url, to: target)) != nil ? target : nil)
            }
        }
    }

    func add() {
        do {
            let core = try SharedStore.core(deviceName: "Share")
            var description = text
            if let link { description = description.isEmpty ? link.absoluteString : "\(link.absoluteString)\n\n\(description)" }
            let id = try core.addTask(
                input: NewTaskInput(
                    title: title, description: description, parentId: nil, projectId: nil, epicId: nil,
                    statusId: nil, priority: nil, dueDate: nil, today: false, tagIds: []),
                day: Session.day(at: Date(), in: .current))
            for image in images {
                _ = try core.attachFile(taskId: id, path: image.path, name: "")
                try? FileManager.default.removeItem(at: image)
            }
            try? core.suspend()
            finish()
        } catch {
            self.error = (error as? AppError)?.message ?? error.localizedDescription
        }
    }
}

struct ShareView: View {
    @Bindable var model: ShareModel

    var body: some View {
        NavigationStack {
            Form {
                Section("Task") {
                    TextField("Title", text: $model.title, axis: .vertical)
                }
                if let link = model.link {
                    Section("Link") { Text(link.absoluteString).lineLimit(3) }
                }
                if !model.text.isEmpty {
                    Section("Text") { Text(model.text).lineLimit(6) }
                }
                if !model.images.isEmpty {
                    Section("Attachments") { Text("\(model.images.count) image(s)") }
                }
                if let error = model.error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Add to Inbox")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { model.finish() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { model.add() }
                        .disabled(model.busy || model.title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

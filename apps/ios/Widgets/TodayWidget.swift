import AppIntents
import SwiftUI
import TaskMasterKit
import WidgetKit

/// Today on the home and lock screen (docs/ios-plan.md P5): the open tasks for today with
/// a checkbox each (a `CompleteTaskIntent`, run here without opening the app), and a tap
/// that opens Today. Plain layout until the design pass.
@main
struct TaskMasterWidgets: WidgetBundle {
    var body: some Widget {
        TodayWidget()
    }
}

struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "today", provider: TodayProvider()) { entry in
            TodayView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(AppLink.today.url)
        }
        .configurationDisplayName("Today")
        .description("Today's open tasks; tick one off from here.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular])
    }
}

struct TodayEntry: TimelineEntry {
    let date: Date
    let tasks: [TaskRow]
    let open: Int
    let error: String?
}

struct TodayProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEntry {
        TodayEntry(date: Date(), tasks: [], open: 0, error: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
        completion(entry())
    }

    /// Read now, and again after midnight (a new day changes what Today holds). The app
    /// and the checkbox reload it sooner.
    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
        let midnight = Calendar.current.nextDate(
            after: Date(), matching: DateComponents(hour: 0, minute: 1), matchingPolicy: .nextTime)
        completion(Timeline(entries: [entry()], policy: midnight.map { .after($0) } ?? .atEnd))
    }

    private func entry() -> TodayEntry {
        do {
            let core = try IntentStore.core()
            try? core.resume()
            let open = try core.list(scope: .today, day: IntentStore.day).compactMap { row -> TaskRow? in
                guard case .task(let task) = row, task.depth == 0, !task.stage.isClosed else { return nil }
                return task
            }
            return TodayEntry(date: Date(), tasks: open, open: open.count, error: nil)
        } catch {
            return TodayEntry(date: Date(), tasks: [], open: 0, error: (error as? AppError)?.message ?? "\(error)")
        }
    }
}

struct TodayView: View {
    let entry: TodayEntry
    @Environment(\.widgetFamily) private var family

    private var limit: Int {
        switch family {
        case .systemSmall, .accessoryRectangular: 3
        case .systemLarge: 9
        default: 4
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.open == 0 ? "Today" : "Today · \(entry.open)")
                .font(.headline)
            if let error = entry.error {
                Text(error).font(.caption).foregroundStyle(.secondary)
            } else if entry.tasks.isEmpty {
                Text("Nothing left for today.").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(entry.tasks.prefix(limit)) { task in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Button(intent: CompleteTaskIntent(task: TaskEntity(id: task.id, title: task.title))) {
                        Image(systemName: "circle")
                    }
                    .buttonStyle(.plain)
                    Link(destination: AppLink.task(id: task.id).url) {
                        Text(task.title).lineLimit(1)
                            .foregroundStyle(task.overdue ? .red : .primary)
                    }
                }
                .font(.subheadline)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

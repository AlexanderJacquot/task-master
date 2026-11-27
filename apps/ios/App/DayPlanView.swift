import SwiftUI
import TaskMasterKit

/// One day: a week strip to pick it, the all-day events, then a timeline of the calendar's
/// events (read-only, in their calendar's colour) and the time blocks (press and drag to
/// move by quarter hours; the menu records how a block went or takes it off). On today,
/// a line marks now and a button lists today's tasks with no time planned.
struct DayPlanView: View {
    let session: Session
    @State private var plan: DayPlanModel
    @State private var today: TaskListModel
    @State private var unplannedOpen = false
    @State private var planningTask: TaskRow?
    /// A task picked in the To plan list, planned once that sheet has closed.
    @State private var picked: TaskRow?

    static let hourHeight: CGFloat = 56

    init(session: Session) {
        self.session = session
        _plan = State(initialValue: DayPlanModel(session: session))
        _today = State(initialValue: TaskListModel(session: session, scope: .today))
    }

    var body: some View {
        let isToday = plan.date == session.day.today
        VStack(spacing: 0) {
            WeekStrip(date: $plan.date, today: session.day.today)
                .padding(.horizontal, 12)
            allDay(isToday: isToday)
            Divider().overlay(Theme.line)
            ScrollViewReader { scroller in
                ScrollView {
                    Timeline(
                        plan: plan, day: dayStart, isToday: isToday)
                        .padding(.horizontal, 16)
                        .padding(.top, 10)
                        .padding(.bottom, 24)
                }
                .onAppear { scrollToStart(scroller, isToday: isToday) }
                .onChange(of: plan.date) { _, _ in scrollToStart(scroller, isToday: plan.date == session.day.today) }
            }
        }
        .background(Theme.ground)
        .navigationTitle("Plan")
        .navigationSubtitle(subtitle)
        .toolbar {
            if !isToday {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Today") { plan.date = session.day.today }
                }
            }
        }
        .task { await plan.refreshCalendar() }
        .refreshable { await plan.refreshCalendar() }
        .sheet(isPresented: $unplannedOpen, onDismiss: {
            // One sheet at a time: the plan editor opens once the list has gone.
            planningTask = picked
            picked = nil
        }) {
            UnplannedSheet(tasks: unplanned, today: session.day.today) { task in
                picked = task
                unplannedOpen = false
            }
        }
        .sheet(item: $planningTask) { task in
            PlanEditor(minutes: task.estimateMin ?? 60) { start, end in
                TaskDetailModel(session: session, id: task.id).schedule(from: start, to: end)
                plan.reload()
            }
        }
    }

    private var subtitle: String {
        guard let date = Dates.parse(plan.date) else { return plan.date }
        return date.formatted(.dateTime.weekday(.wide).day().month(.wide))
    }

    /// Midnight of the shown day, in the phone's zone.
    private var dayStart: Date {
        let parts = plan.date.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return Calendar.current.startOfDay(for: Date()) }
        return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
            ?? Calendar.current.startOfDay(for: Date())
    }

    /// Open tasks for today with no time block today.
    private var unplanned: [TaskRow] {
        let planned = Set(plan.blocks.map(\.taskId))
        return today.tasks.filter { !$0.isClosed && !planned.contains($0.id) }
    }

    @ViewBuilder
    private func allDay(isToday: Bool) -> some View {
        let events = plan.events.filter { $0.startAt == nil }
        let waiting = isToday ? unplanned.count : 0
        let note = calendarNote
        if !events.isEmpty || waiting > 0 || note != nil {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .center, spacing: 8) {
                    if !events.isEmpty {
                        Text("all-day").font(.caption2).foregroundStyle(Theme.ink2).frame(width: 44, alignment: .leading)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(events, id: \.id) { event in
                                    Text(event.title)
                                        .font(.footnote.weight(.medium))
                                        .lineLimit(1)
                                        .padding(.horizontal, 9)
                                        .frame(height: 26)
                                        .foregroundStyle(Theme.ink)
                                        .background(
                                            (Color(hex: event.color) ?? Theme.ink3).opacity(0.22),
                                            in: RoundedRectangle(cornerRadius: 7))
                                }
                            }
                        }
                    } else {
                        Spacer()
                    }
                    if waiting > 0 {
                        Button {
                            unplannedOpen = true
                        } label: {
                            Label("\(waiting) to plan", systemImage: "tray")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Theme.accentText)
                                .padding(.horizontal, 10)
                                .frame(height: 30)
                                .background(Theme.accentSoft, in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Today's tasks with no time planned")
                    }
                }
                if let note {
                    Text(note).font(.caption).foregroundStyle(Theme.ink2)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    /// Why there are no calendar events, when there is a reason to say.
    private var calendarNote: String? {
        switch plan.calendar.availability {
        case .onDesktop: "A desktop runs the calendar sync, so its events stay there."
        case .notConnected: "The server has no calendar connected."
        case .unsupported: "This server is too old to share calendar events."
        case .unknown: nil
        case .available: plan.calendar.lastError.map { "Calendar not refreshed: \($0)" }
        }
    }

    private func scrollToStart(_ scroller: ScrollViewProxy, isToday: Bool) {
        let hour = isToday ? max(Calendar.current.component(.hour, from: Date()) - 1, 0) : 8
        // On appear the timeline has no layout yet, so a direct scroll does nothing.
        Task { @MainActor in scroller.scrollTo("hour-\(hour)", anchor: .top) }
    }
}

/// Seven days around the shown one, Monday first. Swipe for the next or previous week.
struct WeekStrip: View {
    @Binding var date: String
    let today: String

    var body: some View {
        HStack(spacing: 0) {
            ForEach(days, id: \.iso) { day in
                let selected = day.iso == date
                let isToday = day.iso == today
                Button {
                    date = day.iso
                } label: {
                    VStack(spacing: 4) {
                        Text(day.weekday).font(.caption2.weight(.semibold)).foregroundStyle(Theme.ink2)
                        Text(day.number)
                            .font(.body.weight(selected || isToday ? .semibold : .regular))
                            .foregroundStyle(selected ? .white : (isToday ? Theme.accentText : Theme.ink))
                            .frame(width: 34, height: 34)
                            .background(selected ? Theme.accent : .clear, in: Circle())
                    }
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(day.label)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(.vertical, 6)
        .gesture(
            DragGesture(minimumDistance: 30).onEnded { drag in
                if drag.translation.width < -40 { step(7) } else if drag.translation.width > 40 { step(-7) }
            })
    }

    private struct Day {
        let iso: String
        let weekday: String
        let number: String
        let label: String
    }

    private var days: [Day] {
        guard let shown = Dates.parse(date) else { return [] }
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 2
        let start = calendar.dateInterval(of: .weekOfYear, for: shown)?.start ?? shown
        return (0..<7).compactMap { offset in
            guard let day = calendar.date(byAdding: .day, value: offset, to: start) else { return nil }
            return Day(
                iso: Dates.iso(day),
                weekday: day.formatted(.dateTime.weekday(.abbreviated)),
                number: day.formatted(.dateTime.day()),
                label: day.formatted(.dateTime.weekday(.wide).day().month(.wide)))
        }
    }

    private func step(_ days: Int) {
        guard let shown = Dates.parse(date),
            let next = Calendar(identifier: .gregorian).date(byAdding: .day, value: days, to: shown)
        else { return }
        date = Dates.iso(next)
    }
}

/// The hours of a day with the timed events and blocks laid on them; side by side where
/// they overlap.
struct Timeline: View {
    let plan: DayPlanModel
    let day: Date
    let isToday: Bool

    private let hour = DayPlanView.hourHeight
    private let gutter: CGFloat = 52

    var body: some View {
        let items = layout()
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                ForEach(0..<24, id: \.self) { h in
                    HStack(alignment: .top, spacing: 8) {
                        Text(String(format: "%02d:00", h))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(Theme.ink2)
                            .frame(width: gutter - 8, alignment: .leading)
                            .offset(y: -7)
                        Rectangle().fill(Theme.line).frame(height: 1)
                    }
                    .frame(height: hour, alignment: .top)
                    .id("hour-\(h)")
                }
            }
            GeometryReader { proxy in
                let width = proxy.size.width - gutter
                ForEach(items) { item in
                    let columnWidth = width / CGFloat(item.columns)
                    Group {
                        switch item.kind {
                        case .block(let block):
                            BlockView(block: block, height: item.height, plan: plan, hourHeight: hour)
                        case .event(let event):
                            EventView(event: event, height: item.height)
                        }
                    }
                    .frame(width: columnWidth - 3, height: item.height)
                    .offset(x: gutter + CGFloat(item.column) * columnWidth, y: item.top)
                }
                if isToday {
                    let y = offset(of: Session.ms(Date()))
                    HStack(spacing: 0) {
                        Circle().fill(Theme.now).frame(width: 9, height: 9)
                        Rectangle().fill(Theme.now).frame(height: 2)
                    }
                    .frame(width: width + 4)
                    .offset(x: gutter - 4, y: y - 4.5)
                    .accessibilityElement()
                    .accessibilityLabel("Now, \(clockTime(Session.ms(Date())))")
                }
            }
        }
        .frame(height: hour * 24)
    }

    private struct Placed: Identifiable {
        enum Kind {
            case block(BlockItem)
            case event(EventItem)
        }
        let id: String
        let kind: Kind
        let start: Int64
        let end: Int64
        var top: CGFloat = 0
        var height: CGFloat = 0
        var column = 0
        var columns = 1
    }

    private func offset(of ms: Int64) -> CGFloat {
        CGFloat(Double(ms - Session.ms(day)) / 3_600_000) * hour
    }

    /// Positions, and columns for overlapping items (greedy, per cluster).
    private func layout() -> [Placed] {
        var items: [Placed] =
            plan.blocks.map { Placed(id: "b-\($0.id)", kind: .block($0), start: $0.startAt, end: $0.endAt) }
            + plan.events.compactMap { event in
                guard let start = event.startAt, let end = event.endAt else { return nil }
                return Placed(id: "e-\(event.id)", kind: .event(event), start: start, end: end)
            }
        items.sort { $0.start < $1.start }
        let dayStart = Session.ms(day)
        let dayEnd = dayStart + 24 * 3_600_000
        var cluster: [Int] = []
        var clusterEnd: Int64 = .min
        var columnEnds: [Int64] = []
        func close() {
            for i in cluster { items[i].columns = max(columnEnds.count, 1) }
            cluster = []
            columnEnds = []
        }
        for i in items.indices {
            let start = max(items[i].start, dayStart)
            let end = min(max(items[i].end, start + 15 * 60_000), dayEnd)
            items[i].top = offset(of: start)
            items[i].height = max(offset(of: end) - items[i].top - 2, 22)
            if items[i].start >= clusterEnd { close() }
            if let free = columnEnds.firstIndex(where: { $0 <= items[i].start }) {
                items[i].column = free
                columnEnds[free] = items[i].end
            } else {
                items[i].column = columnEnds.count
                columnEnds.append(items[i].end)
            }
            cluster.append(i)
            clusterEnd = max(clusterEnd, items[i].end)
        }
        close()
        return items
    }
}

/// A time block: its task, a ring that ticks once done. Press and drag to move it.
struct BlockView: View {
    let block: BlockItem
    let height: CGFloat
    let plan: DayPlanModel
    let hourHeight: CGFloat
    @State private var drag: CGFloat = 0
    @GestureState private var pressing = false

    var body: some View {
        let compact = height < 44
        NavigationLink(value: Route.task(id: block.taskId)) {
            HStack(alignment: compact ? .center : .top, spacing: 8) {
                Image(systemName: icon).font(.footnote).padding(.top, compact ? 0 : 1)
                if compact {
                    Text(block.title).font(.footnote.weight(.semibold)).lineLimit(1)
                    Text(clockTime(block.startAt)).font(.caption).opacity(0.85)
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(block.title).font(.footnote.weight(.semibold)).lineLimit(2)
                        Text("\(clockTime(block.startAt)) – \(clockTime(block.endAt))")
                            .font(.caption).opacity(0.85)
                    }
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.blockInk)
            .padding(.horizontal, 10)
            .padding(.vertical, compact ? 2 : 7)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Theme.blockSoft, in: RoundedRectangle(cornerRadius: 8))
            .overlay {
                if block.outcome == .missed {
                    RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.danger.opacity(0.6), lineWidth: 1)
                }
            }
        }
        .buttonStyle(.plain)
        .offset(y: drag)
        .scaleEffect(pressing ? 1.02 : 1)
        .shadow(color: .black.opacity(drag != 0 ? 0.15 : 0), radius: 8, y: 4)
        .animation(.snappy, value: pressing)
        .gesture(move)
        .contextMenu {
            Button("Done", systemImage: "checkmark.circle") { plan.setOutcome(block, .done) }
            Button("Worked on it", systemImage: "circle.lefthalf.filled") { plan.setOutcome(block, .worked) }
            Button("Missed", systemImage: "xmark.circle") { plan.setOutcome(block, .missed) }
            if block.outcome != .planned {
                Button("Planned", systemImage: "circle") { plan.setOutcome(block, .planned) }
            }
            Divider()
            Button("15 min longer", systemImage: "plus") { resize(by: 15) }
            if block.endAt - block.startAt > 15 * 60_000 {
                Button("15 min shorter", systemImage: "minus") { resize(by: -15) }
            }
            Divider()
            Button("Take off the plan", systemImage: "calendar.badge.minus", role: .destructive) {
                plan.unschedule(block)
            }
        }
        .accessibilityLabel("\(block.title), \(clockTime(block.startAt)) to \(clockTime(block.endAt))")
        .accessibilityAction(named: "15 min later") { shift(minutes: 15) }
        .accessibilityAction(named: "15 min earlier") { shift(minutes: -15) }
    }

    private var icon: String {
        switch block.outcome {
        case .done: "checkmark.circle.fill"
        case .worked: "circle.lefthalf.filled"
        case .missed: "xmark.circle"
        case .planned, .cancelled: "circle"
        }
    }

    /// Long press, then drag: the block follows by quarter hours and moves on release.
    private var move: some Gesture {
        LongPressGesture(minimumDuration: 0.35)
            .updating($pressing) { value, state, _ in state = value }
            .sequenced(before: DragGesture(minimumDistance: 0))
            .onChanged { value in
                if case .second(true, let drag?) = value {
                    let quarter = hourHeight / 4
                    self.drag = (drag.translation.height / quarter).rounded() * quarter
                }
            }
            .onEnded { _ in
                let quarters = Int((drag / (hourHeight / 4)).rounded())
                drag = 0
                if quarters != 0 { shift(minutes: quarters * 15) }
            }
    }

    private func shift(minutes: Int) {
        let delta = Double(minutes * 60)
        plan.move(
            block, start: Session.date(block.startAt).addingTimeInterval(delta),
            end: Session.date(block.endAt).addingTimeInterval(delta))
    }

    private func resize(by minutes: Int) {
        plan.move(
            block, start: Session.date(block.startAt),
            end: Session.date(block.endAt).addingTimeInterval(Double(minutes * 60)))
    }
}

/// A calendar event: read-only, in its calendar's colour; opens its link when it has one.
struct EventView: View {
    let event: EventItem
    let height: CGFloat
    @Environment(\.openURL) private var openURL

    var body: some View {
        let color = Color(hex: event.color) ?? Theme.ink3
        let compact = height < 44
        Button {
            if let link = event.link, let url = URL(string: link) { openURL(url) }
        } label: {
            HStack(alignment: compact ? .center : .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5).fill(color).frame(width: 3)
                    .padding(.vertical, compact ? 4 : 0)
                if compact {
                    Text(event.title).font(.footnote.weight(.semibold)).lineLimit(1)
                    Text(details).font(.caption).foregroundStyle(Theme.ink2).lineLimit(1)
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(event.title).font(.footnote.weight(.semibold)).lineLimit(2)
                        Text(details).font(.caption).foregroundStyle(Theme.ink2).lineLimit(1)
                    }
                    .padding(.vertical, 7)
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.ink)
            .padding(.leading, 4)
            .padding(.trailing, 8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(color.opacity(0.16), in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(event.link == nil)
        .accessibilityLabel("\(event.title), \(details)")
    }

    private var details: String {
        var parts: [String] = []
        if let start = event.startAt, let end = event.endAt {
            parts.append("\(clockTime(start)) – \(clockTime(end))")
        }
        if let location = event.location, !location.isEmpty { parts.append(location) }
        if !event.calendarName.isEmpty { parts.append(event.calendarName) }
        return parts.joined(separator: " · ")
    }
}

/// Today's tasks with no time planned; picking one plans it.
struct UnplannedSheet: View {
    let tasks: [TaskRow]
    let today: String
    let pick: (TaskRow) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(tasks) { task in
                // The row's own check button stays inert: a tap anywhere picks the task.
                TaskRowView(task: task, today: today) {}
                    .allowsHitTesting(false)
                    .overlay {
                        Color.clear.contentShape(Rectangle()).onTapGesture { pick(task) }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { pick(task) }
            }
            .listStyle(.plain)
            .navigationTitle("To plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

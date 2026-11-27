import SwiftUI
import TaskMasterKit

/// The clean look's colours (ADR 039, apps/desktop/src/index.css `:root.clean` and
/// `.clean.dark`), adapted for small text on the phone: where a token was below 4.5:1 on
/// its ground it is a step darker (light) or lighter (dark). The mockups are the
/// "task-master iPhone mockups" design canvas.
enum Theme {
    static let ink = Color(light: 0x37352F, dark: 0xE8E7E4)
    static let ink2 = Color(light: 0x6B6A66, dark: 0xA3A29E)
    static let ink3 = Color(light: 0x8A8984, dark: 0x82817D)
    static let ground = Color(light: 0xFFFFFF, dark: 0x191919)
    static let raised = Color(light: 0xFFFFFF, dark: 0x2A2A2A)
    /// Behind grouped lists (Browse), so their raised cards stand out.
    static let grouped = Color(light: 0xF7F7F5, dark: 0x191919)
    static let fill = Color(light: 0x37352F, dark: 0xFFFFFF, lightAlpha: 0.055, darkAlpha: 0.07)
    static let line = Color(light: 0x37352F, dark: 0xFFFFFF, lightAlpha: 0.09, darkAlpha: 0.085)

    static let accent = Color(light: 0x2383E2, dark: 0x3B91EA)
    /// Accent text and icons on the ground.
    static let accentText = Color(light: 0x1A6FC4, dark: 0x5AA3EE)
    static let accentSoft = Color(light: 0xEEF5FD, dark: 0x3B91EA, darkAlpha: 0.16)

    static let danger = Color(light: 0xC23F3A, dark: 0xEB6F68)
    static let high = Color(light: 0xB35C0E, dark: 0xE0893B)
    static let done = Color(light: 0x448361, dark: 0x55B080)
    static let now = Color(light: 0xD44C47, dark: 0xEB6F68)

    /// Status chips: in progress, to do, and anything waiting.
    static let progressSoft = Color(light: 0xE3EEFB, dark: 0x3B91EA, darkAlpha: 0.16)
    static let progressInk = Color(light: 0x1A5FA8, dark: 0x8CBDF2)
    static let highSoft = Color(light: 0xFBECDD, dark: 0xE0893B, darkAlpha: 0.16)
    static let highInk = Color(light: 0x8F4A0B, dark: 0xEFA767)

    /// Time blocks on the day plan.
    static let blockSoft = Color(light: 0xDCEBFB, dark: 0x3B91EA, darkAlpha: 0.24)
    static let blockInk = Color(light: 0x174F8C, dark: 0xCFE3FA)

    /// A project's colour, or the ink's when it has none.
    static func project(_ hex: String?) -> Color { Color(hex: hex) ?? ink3 }

    /// The check's colour for a task of this priority.
    static func check(_ priority: Priority) -> Color {
        switch priority {
        case .urgent: danger
        case .high: high
        case .normal, .low: ink3
        }
    }
}

extension Color {
    /// One colour in light mode and another in dark.
    init(light: UInt32, dark: UInt32, lightAlpha: Double = 1, darkAlpha: Double = 1) {
        self.init(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(rgb: dark, alpha: darkAlpha) : UIColor(rgb: light, alpha: lightAlpha)
        })
    }
}

extension UIColor {
    convenience init(rgb: UInt32, alpha: Double) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255, alpha: alpha)
    }
}

/// The small caps label over a section ("OVERDUE", "SUBTASKS").
struct SectionLabel: View {
    let title: String
    var detail: String?
    var color: Color = Theme.ink

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(color)
            if let detail { Text(detail).font(.footnote).foregroundStyle(Theme.ink2) }
            Spacer()
        }
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A large title with a small line over it, as Today, Inbox and Plan open.
struct ScreenTitle: View {
    let eyebrow: String
    let title: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(eyebrow.uppercased())
                .font(.footnote.weight(.semibold))
                .tracking(0.3)
                .foregroundStyle(Theme.ink2)
            Text(title).font(.largeTitle.bold())
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A rounded label for a field (status, due date, priority...). Tinted when set.
struct Chip: View {
    let label: String
    var systemImage: String?
    var ink: Color = Theme.ink
    var ground: Color = Theme.fill
    var bold = false

    var body: some View {
        HStack(spacing: 6) {
            if let systemImage { Image(systemName: systemImage).imageScale(.small) }
            Text(label)
        }
        .font(.subheadline.weight(bold ? .semibold : .medium))
        .foregroundStyle(ink)
        .padding(.horizontal, 12)
        .frame(minHeight: 32)
        .background(ground, in: Capsule())
        .contentShape(Capsule())
    }
}

/// Lays chips out in rows, wrapping at the edge.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.last.map { $0.y + $0.height } ?? 0
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(width: bounds.width, subviews: subviews) {
            for (index, x) in row.items {
                subviews[index].place(
                    at: CGPoint(x: bounds.minX + x, y: bounds.minY + row.y), proposal: .unspecified)
            }
        }
    }

    private struct Row {
        var items: [(Int, CGFloat)] = []
        var y: CGFloat = 0
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for (index, view) in subviews.enumerated() {
            let size = view.sizeThatFits(.unspecified)
            var row = rows[rows.count - 1]
            if !row.items.isEmpty && row.width + spacing + size.width > width {
                let y = row.y + row.height + spacing
                rows.append(Row(y: y))
                row = rows[rows.count - 1]
            }
            let x = row.items.isEmpty ? 0 : row.width + spacing
            row.items.append((index, x))
            row.width = x + size.width
            row.height = max(row.height, size.height)
            rows[rows.count - 1] = row
        }
        return rows
    }
}

// MARK: Dates

enum Dates {
    static func parse(_ iso: String) -> Date? {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: iso)
    }

    static func iso(_ date: Date) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }

    /// "today", "tomorrow", "yesterday", else "Thu 26 Nov".
    static func relative(_ iso: String, today: String) -> String {
        guard let date = parse(iso), let now = parse(today) else { return iso }
        let days = Calendar(identifier: .gregorian).dateComponents([.day], from: now, to: date).day ?? 0
        switch days {
        case 0: return "today"
        case 1: return "tomorrow"
        case -1: return "yesterday"
        default: return date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
        }
    }

    /// "45m", "1h 30m".
    static func duration(minutes: Int64) -> String {
        let h = minutes / 60
        let m = minutes % 60
        if h == 0 { return "\(m)m" }
        return m == 0 ? "\(h)h" : "\(h)h \(m)m"
    }
}

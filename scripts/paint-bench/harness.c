/* Paint benchmark harness: opens a page in a WebKitGTK webview, waits for the page to set
 * its title to "start", then to a JSON result, and prints that result with the CPU seconds
 * WebKit spent in its Skia CPU raster threads in between. Built against the system
 * webkit2gtk-4.1; run.sh points LD_LIBRARY_PATH at an AppImage to test its bundled copy
 * (the 4.1 ABI is stable). See docs/rendering-performance.md. */
#include <gtk/gtk.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <webkit2/webkit2.h>

static double before;

static double skia_cpu_seconds(void) {
  char cmd[512];
  snprintf(cmd, sizeof cmd, "sh '%s/skia-cpu.sh' %d", getenv("PAINT_BENCH_DIR"), getpid());
  FILE *f = popen(cmd, "r");
  double v = 0;
  if (f) {
    if (fscanf(f, "%lf", &v) != 1) v = 0;
    pclose(f);
  }
  return v;
}

static void on_title(WebKitWebView *view, GParamSpec *pspec, gpointer data) {
  (void)pspec;
  (void)data;
  const char *t = webkit_web_view_get_title(view);
  if (!t || !*t) return;
  if (!strcmp(t, "start")) {
    before = skia_cpu_seconds();
  } else if (t[0] == '{') {
    printf("%s skia_cpu_s=%.2f webkit=%u.%u.%u\n", t, skia_cpu_seconds() - before,
           webkit_get_major_version(), webkit_get_minor_version(), webkit_get_micro_version());
    fflush(stdout);
    gtk_main_quit();
  }
}

static gboolean on_timeout(gpointer data) {
  (void)data;
  fprintf(stderr, "timed out\n");
  gtk_main_quit();
  return G_SOURCE_REMOVE;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: harness file:///page.html\n");
    return 2;
  }
  gtk_init(&argc, &argv);
  GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_default_size(GTK_WINDOW(window), 1600, 1000);
  GtkWidget *view = webkit_web_view_new();
  gtk_container_add(GTK_CONTAINER(window), view);
  g_signal_connect(view, "notify::title", G_CALLBACK(on_title), NULL);
  webkit_web_view_load_uri(WEBKIT_WEB_VIEW(view), argv[1]);
  gtk_widget_show_all(window);
  g_timeout_add_seconds(40, on_timeout, NULL);
  gtk_main();
  return 0;
}

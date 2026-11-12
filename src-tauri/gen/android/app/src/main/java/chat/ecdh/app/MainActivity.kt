package chat.ecdh.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    createMessageChannel()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Keeps the chat out of screenshots, screen recordings and the recent-apps preview, like the
    // desktop app does by default.
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)

    // Android draws the app behind the status bar, the navigation bar and the keyboard. The page
    // is kept clear of all three, so the header stays visible and the message box sits on top of
    // the keyboard.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  // Message alerts go to this channel (the page names it: public/js/alerts.js). The notification
  // plugin's own "default" channel has default importance, which only shows an icon in the
  // status bar, and the plugin re-creates it on every start, which would lower any importance
  // set on it here. A chat alert should pop up like other messengers' do, so it gets its own
  // channel. The alert itself never says more than "New message".
  private fun createMessageChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel("messages", "Messages", NotificationManager.IMPORTANCE_HIGH)
    channel.description = "New messages and calls while ecdh.chat is in the background"
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }
}

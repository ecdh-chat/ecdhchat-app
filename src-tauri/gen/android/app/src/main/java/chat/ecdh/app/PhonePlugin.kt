package chat.ecdh.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.OutputStream

@InvokeArg
class SaveFileArgs {
  lateinit var name: String
  var mime: String = ""
}

@InvokeArg
class SaveChunkArgs {
  lateinit var data: String
}

@InvokeArg
class SaveEndArgs {
  var discard: Boolean = false
}

// What the phone app does for its page that a webview can't do itself. The page reaches it through
// "plugin:phone|…" commands, each allowed by name in src-tauri/capabilities/mobile.json.
//
// Saving a received file: the phone's webview has no way to download the page's own blob: links,
// so the page hands the file over (public/js/mobile.js). saveFile asks the person where to put it
// on the system's own "save as" screen, so the app needs no storage permission and can only write
// the one file the person named; saveChunk writes the next piece of it; saveEnd closes it, or
// removes it if the page gave up part-way.
@TauriPlugin
class PhonePlugin(private val activity: Activity) : Plugin(activity) {
  private var saving: OutputStream? = null
  private var savingTo: Uri? = null
  private var written = 0L

  @Command
  fun saveFile(invoke: Invoke) {
    val args = invoke.parseArgs(SaveFileArgs::class.java)
    endSave(discard = true)
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = if (MIME.matches(args.mime)) args.mime else "application/octet-stream"
      putExtra(Intent.EXTRA_TITLE, args.name.take(MAX_NAME))
    }
    startActivityForResult(invoke, intent, "savePicked")
  }

  // Resolves to { saving: false } when the person backed out without choosing a place.
  @ActivityCallback
  fun savePicked(invoke: Invoke, result: ActivityResult) {
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null) {
      invoke.resolve(JSObject().put("saving", false))
      return
    }
    try {
      saving = activity.contentResolver.openOutputStream(uri, "w") ?: throw IllegalStateException("The file can't be written")
      savingTo = uri
      written = 0
      invoke.resolve(JSObject().put("saving", true))
    } catch (e: Exception) {
      invoke.reject(e.message)
    }
  }

  @Command
  fun saveChunk(invoke: Invoke) {
    val args = invoke.parseArgs(SaveChunkArgs::class.java)
    val out = saving ?: return invoke.reject("No file is being saved")
    try {
      val bytes = Base64.decode(args.data, Base64.DEFAULT)
      if (written + bytes.size > MAX_SIZE) throw IllegalStateException("The file is too large")
      out.write(bytes)
      written += bytes.size
      invoke.resolve()
    } catch (e: Exception) {
      endSave(discard = true)
      invoke.reject(e.message)
    }
  }

  @Command
  fun saveEnd(invoke: Invoke) {
    val args = invoke.parseArgs(SaveEndArgs::class.java)
    try {
      endSave(args.discard)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message)
    }
  }

  private fun endSave(discard: Boolean) {
    val out = saving
    val uri = savingTo
    saving = null
    savingTo = null
    try {
      out?.close()
    } finally {
      if (discard && uri != null) runCatching { DocumentsContract.deleteDocument(activity.contentResolver, uri) }
    }
  }

  companion object {
    // The page never sends a bigger file than this (MAX_FILE_SIZE in public/js/config.js).
    private const val MAX_SIZE = 100L * 1024 * 1024
    private const val MAX_NAME = 255
    private val MIME = Regex("^[a-z0-9.+-]+/[a-z0-9.+-]+$")
  }
}

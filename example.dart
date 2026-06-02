import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';

// ============================================================================
//  Models
// ============================================================================

class ReceiptItem {
  final String name;
  final int quantity;
  final double unitPrice;
  final double totalPrice;

  ReceiptItem({
    required this.name,
    required this.quantity,
    required this.unitPrice,
    required this.totalPrice,
  });

  factory ReceiptItem.fromJson(Map<String, dynamic> json) => ReceiptItem(
    name: json['name'] as String? ?? '',
    quantity: (json['quantity'] as num?)?.toInt() ?? 1,
    unitPrice: (json['unitPrice'] as num?)?.toDouble() ?? 0.0,
    totalPrice: (json['totalPrice'] as num?)?.toDouble() ?? 0.0,
  );
}

class ReceiptData {
  final String supplierName;
  final String orderDate;
  final List<ReceiptItem> orderItems;
  final double totalPrice;

  ReceiptData({
    required this.supplierName,
    required this.orderDate,
    required this.orderItems,
    required this.totalPrice,
  });

  factory ReceiptData.fromJson(Map<String, dynamic> json) => ReceiptData(
    supplierName: json['supplierName'] as String? ?? 'Unknown',
    orderDate: json['orderDate'] as String? ?? '',
    orderItems:
        (json['orderItems'] as List<dynamic>?)
            ?.map((e) => ReceiptItem.fromJson(e as Map<String, dynamic>))
            .toList() ??
        [],
    totalPrice: (json['totalPrice'] as num?)?.toDouble() ?? 0.0,
  );
}

class PostOpData {
  final String postOpNotes;
  final List<String> prescriptions;
  final double price;
  final double paid;
  final Map<String, String> teeth;
  final Map<String, String> teethExtraNotes;
  final bool hasLabwork;
  final String labName;
  final String labworkNotes;

  PostOpData({
    required this.postOpNotes,
    required this.prescriptions,
    required this.price,
    required this.paid,
    required this.teeth,
    required this.teethExtraNotes,
    required this.hasLabwork,
    required this.labName,
    required this.labworkNotes,
  });

  factory PostOpData.fromJson(Map<String, dynamic> json) => PostOpData(
    postOpNotes: json['postOpNotes'] as String? ?? '',
    prescriptions:
        (json['prescriptions'] as List<dynamic>?)
            ?.map((e) => e as String)
            .toList() ??
        [],
    price: (json['price'] as num?)?.toDouble() ?? 0.0,
    paid: (json['paid'] as num?)?.toDouble() ?? 0.0,
    teeth:
        (json['teeth'] as Map<String, dynamic>?)?.map(
          (k, v) => MapEntry(k, v as String),
        ) ??
        {},
    teethExtraNotes:
        (json['teethExtraNotes'] as Map<String, dynamic>?)?.map(
          (k, v) => MapEntry(k, v as String),
        ) ??
        {},
    hasLabwork: json['hasLabwork'] as bool? ?? false,
    labName: json['labName'] as String? ?? '',
    labworkNotes: json['labworkNotes'] as String? ?? '',
  );
}

class DentalHistoryData {
  final Map<String, String> teeth;
  final Map<String, String> teethExtraNotes;

  DentalHistoryData({required this.teeth, required this.teethExtraNotes});

  factory DentalHistoryData.fromJson(Map<String, dynamic> json) =>
      DentalHistoryData(
        teeth:
            (json['teeth'] as Map<String, dynamic>?)?.map(
              (k, v) => MapEntry(k, v as String),
            ) ??
            {},
        teethExtraNotes:
            (json['teethExtraNotes'] as Map<String, dynamic>?)?.map(
              (k, v) => MapEntry(k, v as String),
            ) ??
            {},
      );
}

// ============================================================================
//  Services
// ============================================================================

T _parse<T>(http.Response r, T Function(Map<String, dynamic>) fromJson) {
  final body = jsonDecode(r.body) as Map<String, dynamic>;
  if (r.statusCode == 200) return fromJson(body);
  throw Exception(body['error'] ?? 'Request failed (${r.statusCode})');
}

class ExpenseReaderService {
  final String workerUrl;
  final String server;
  final String key;
  final List<String>? suppliers; // optional — can be null

  const ExpenseReaderService({
    required this.workerUrl,
    required this.server,
    required this.key,
    this.suppliers,
  });

  Future<ReceiptData> readReceiptFromFile(String imagePath) async {
    final bytes = await File(imagePath).readAsBytes();
    return _sendImage(bytes);
  }

  Future<ReceiptData> readReceiptFromPicker() async {
    final xFile = await ImagePicker().pickImage(source: ImageSource.gallery);
    if (xFile == null) throw Exception('No image selected');
    return _sendImage(await xFile.readAsBytes());
  }

  Future<ReceiptData> _sendImage(List<int> bytes) async {
    final r = http.MultipartRequest('POST', Uri.parse('$workerUrl/expense'));
    r.headers['x-server'] = server;
    r.headers['x-worker-key'] = key;
    if (suppliers != null && suppliers.isNotEmpty) {
      r.fields['suppliers'] = suppliers.join(',');
    }
    r.files.add(
      http.MultipartFile.fromBytes('image', bytes, filename: 'receipt.jpg'),
    );
    final res = await http.Response.fromStream(await r.send());
    return _parse(res, ReceiptData.fromJson);
  }
}

class PostOpService {
  final String workerUrl;
  final String server;
  final String key;

  const PostOpService({
    required this.workerUrl,
    required this.server,
    required this.key,
  });

  /// Send an audio recording to /post-op-notes.
  ///
  /// [existingFields] — pre-filled fields from the UI. Gemini merges the
  /// audio notes with these, with audio taking precedence on conflicts.
  ///
  /// [lang] — optional 2-letter language code (e.g. "en", "ar"). When set,
  /// `postOpNotes`, `teethExtraNotes`, and `labworkNotes` are translated.
  Future<PostOpData> processAudio(
    List<int> audioBytes,
    String filename, {
    PostOpData? existingFields,
    String? lang,
  }) async {
    final r = http.MultipartRequest(
      'POST',
      Uri.parse('$workerUrl/post-op-notes'),
    );
    r.headers['x-server'] = server;
    r.headers['x-worker-key'] = key;
    if (existingFields != null) {
      r.fields['existingFields'] = jsonEncode(existingFields);
    }
    if (lang != null) {
      r.fields['lang'] = lang;
    }
    r.files.add(
      http.MultipartFile.fromBytes('audio', audioBytes, filename: filename),
    );
    final res = await http.Response.fromStream(await r.send());
    return _parse(res, PostOpData.fromJson);
  }

  Future<PostOpData> processAudioFromFile(
    String path, {
    PostOpData? existingFields,
    String? lang,
  }) async => processAudio(
    await File(path).readAsBytes(),
    path.split('/').last,
    existingFields: existingFields,
    lang: lang,
  );
}

class DentalHistoryService {
  final String workerUrl;
  final String server;
  final String key;

  const DentalHistoryService({
    required this.workerUrl,
    required this.server,
    required this.key,
  });

  /// Send an audio recording to /dental-history.
  ///
  /// [lang] — optional 2-letter language code. When set,
  /// `teethExtraNotes` values are translated.
  Future<DentalHistoryData> processAudio(
    List<int> audioBytes,
    String filename, {
    String? lang,
  }) async {
    final r = http.MultipartRequest(
      'POST',
      Uri.parse('$workerUrl/dental-history'),
    );
    r.headers['x-server'] = server;
    r.headers['x-worker-key'] = key;
    if (lang != null) r.fields['lang'] = lang;
    r.files.add(
      http.MultipartFile.fromBytes('audio', audioBytes, filename: filename),
    );
    final res = await http.Response.fromStream(await r.send());
    return _parse(res, DentalHistoryData.fromJson);
  }

  Future<DentalHistoryData> processAudioFromFile(
    String path, {
    String? lang,
  }) async => processAudio(
    await File(path).readAsBytes(),
    path.split('/').last,
    lang: lang,
  );
}

// ============================================================================
//  Examples
// ============================================================================

Future<void> main() async {
  // ---- Expense ----
  final expense = ExpenseReaderService(
    workerUrl: 'https://apexo-ai-services.your-subdomain.workers.dev',
    server: 'my-clinic-server',
    key: 'my-secret-key',
    suppliers: ['Walmart', 'Costco', 'Target'],
  );

  try {
    final r = await expense.readReceiptFromPicker();
    print('Supplier: ${r.supplierName}');
    print('Date: ${r.orderDate}');
    print('Total: \$${r.totalPrice.toStringAsFixed(2)}');
    for (final i in r.orderItems) {
      print(
        '  - ${i.name} x${i.quantity} @ \$${i.unitPrice.toStringAsFixed(2)}',
      );
    }
  } catch (e) {
    print('Expense error: $e');
  }

  // ---- Post-Op Notes ----
  final postOp = PostOpService(
    workerUrl: 'https://apexo-ai-services.your-subdomain.workers.dev',
    server: 'my-clinic-server',
    key: 'my-secret-key',
  );

  try {
    final notes = await postOp.processAudioFromFile(
      '/path/to/voice-note.m4a',
      existingFields: PostOpData(
        postOpNotes: '',
        prescriptions: [],
        price: 500,
        paid: 0,
        teeth: {'11': 'filling'},
        teethExtraNotes: {},
        hasLabwork: false,
        labName: '',
        labworkNotes: '',
      ),
      lang: 'en', // translate note fields to English
    );
    print('\nPost-op: ${notes.teeth}');
    print('Price: ${notes.price}  Paid: ${notes.paid}');
    print('Rx: ${notes.prescriptions}');
    print('Lab: ${notes.hasLabwork}');
  } catch (e) {
    print('Post-op error: $e');
  }

  // ---- Dental History ----
  final dentalHistory = DentalHistoryService(
    workerUrl: 'https://apexo-ai-services.your-subdomain.workers.dev',
    server: 'my-clinic-server',
    key: 'my-secret-key',
  );

  try {
    final history = await dentalHistory.processAudioFromFile(
      '/path/to/patient-history.m4a',
      lang: 'en',
    );
    print('\nDental history teeth: ${history.teeth}');
    print('Teeth notes: ${history.teethExtraNotes}');
  } catch (e) {
    print('Dental history error: $e');
  }
}

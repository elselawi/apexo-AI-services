import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';

/// Response model matching the worker's JSON output.
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
  final String orderDate; // YYYY-MM-DD
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

/// Service that calls the Cloudflare Worker.
class ExpenseReaderService {
  final String workerUrl;
  final String server;
  final String key;

  /// List of supplier names to match against.
  /// Pass these per-request — the worker requires them.
  final List<String> suppliers;

  const ExpenseReaderService({
    required this.workerUrl,
    required this.server,
    required this.key,
    required this.suppliers,
  });

  /// Reads a receipt image from a file path and returns structured data.
  Future<ReceiptData> readReceiptFromFile(String imagePath) async {
    final bytes = await File(imagePath).readAsBytes();
    return _sendImage(bytes);
  }

  /// Reads a receipt image picked via image_picker.
  Future<ReceiptData> readReceiptFromPicker() async {
    final picker = ImagePicker();
    final xFile = await picker.pickImage(source: ImageSource.gallery);

    if (xFile == null) {
      throw Exception('No image selected');
    }

    final bytes = await xFile.readAsBytes();
    return _sendImage(bytes);
  }

  /// Sends raw image bytes to the worker as multipart/form-data.
  Future<ReceiptData> _sendImage(List<int> bytes) async {
    final uri = Uri.parse(workerUrl);
    final request = http.MultipartRequest('POST', uri);

    // Auth via headers
    request.headers['x-server'] = server;
    request.headers['x-worker-key'] = key;

    // Suppliers as a form field
    request.fields['suppliers'] = suppliers.join(',');

    // Attach the image file
    request.files.add(
      http.MultipartFile.fromBytes('image', bytes, filename: 'receipt.jpg'),
    );

    final streamedResponse = await request.send();
    final response = await http.Response.fromStream(streamedResponse);

    if (response.statusCode == 200) {
      final json = jsonDecode(response.body) as Map<String, dynamic>;
      return ReceiptData.fromJson(json);
    } else if (response.statusCode == 401) {
      final json = jsonDecode(response.body) as Map<String, dynamic>;
      throw Exception(
        'Authentication failed: ${json['error'] ?? 'Unknown error'}',
      );
    } else {
      final json = jsonDecode(response.body) as Map<String, dynamic>;
      throw Exception(
        json['error'] ?? 'Request failed (${response.statusCode})',
      );
    }
  }
}

// ---- Usage example ----

Future<void> main() async {
  final service = ExpenseReaderService(
    workerUrl: 'https://expense-reader.your-subdomain.workers.dev',
    server: 'my-clinic-server',
    key: 'my-secret-key',
    suppliers: [
      'Walmart',
      'Costco',
      'Target',
      'Amazon',
      'Home Depot',
      'Staples',
    ],
  );

  try {
    // Option A: pick from gallery
    final receipt = await service.readReceiptFromPicker();
    print('Supplier: ${receipt.supplierName}');
    print('Date: ${receipt.orderDate}');
    print('Total: \$${receipt.totalPrice.toStringAsFixed(2)}');
    print('Items:');
    for (final item in receipt.orderItems) {
      print(
        '  - ${item.name} x${item.quantity} @ \$${item.unitPrice.toStringAsFixed(2)} = \$${item.totalPrice.toStringAsFixed(2)}',
      );
    }

    // Option B: from a known file path
    // final receipt = await service.readReceiptFromFile('/path/to/receipt.jpg');
  } catch (e) {
    print('Error: $e');
  }
}

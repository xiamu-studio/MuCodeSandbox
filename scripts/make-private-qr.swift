import AppKit
import CoreImage
import Vision

guard CommandLine.arguments.count == 3 else {
    fatalError("Expected input text file and output PNG path.")
}
let text = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
    .trimmingCharacters(in: .whitespacesAndNewlines)
guard let inputData = text.data(using: .utf8),
      let filter = CIFilter(name: "CIQRCodeGenerator") else {
    fatalError("QR generation is unavailable.")
}
filter.setValue(inputData, forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
guard let rawImage = filter.outputImage else { fatalError("QR generation failed.") }
let scale: CGFloat = 12
let margin: CGFloat = 4 * scale
let scaled = rawImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
let bounds = scaled.extent.insetBy(dx: -margin, dy: -margin)
let white = CIImage(color: CIColor.white).cropped(to: bounds)
let finished = scaled.composited(over: white)
let context = CIContext(options: [.useSoftwareRenderer: true])
guard let bitmap = context.createCGImage(finished, from: bounds) else {
    fatalError("QR raster rendering failed.")
}
let representation = NSBitmapImageRep(cgImage: bitmap)
guard let png = representation.representation(using: .png, properties: [:]) else {
    fatalError("QR PNG encoding failed.")
}
let output = URL(fileURLWithPath: CommandLine.arguments[2])
try png.write(to: output, options: .atomic)
try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)

let request = VNDetectBarcodesRequest()
request.symbologies = [.qr]
try VNImageRequestHandler(url: output).perform([request])
guard request.results?.contains(where: { $0.payloadStringValue == text }) == true else {
    fatalError("Generated QR did not decode to the original content.")
}
print("QR content verified; secret payload was not printed.")

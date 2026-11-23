require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CapacitorSmb'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/AhmadAC/WebLauncher'
  s.author = 'AhmadAC'
  s.source = { :git => 'https://github.com/AhmadAC/WebLauncher.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/SmbPlugin/**/*.{swift,h,m}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.dependency 'AMSMB2', '~> 3.0'
  s.swift_version = '5.9'
end

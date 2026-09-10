targetScope = 'resourceGroup'

@description('Name of the dedicated retained TEST Static Web App, never the production website.')
@minLength(1)
@maxLength(40)
param staticSiteName string

@description('Globally unique storage account name: 3-24 lowercase letters and digits.')
@minLength(3)
@maxLength(24)
param storageAccountName string

@description('Public-media container name; use Azure lowercase container naming rules.')
@minLength(3)
@maxLength(63)
param mediaContainerName string = 'recipe-media'

@description('Approved region for both test resources; confirm service and subscription availability.')
param location string = 'westeurope'

@description('Normally true. False is only for the reviewed empty-resource first pass when what-if cannot resolve the new SWA hostname; enable before uploading media.')
param includeTestOrigin bool = true

var resourceTags = {
  environment: 'family-test'
  purpose: 'nonpromotable-dev-test'
  retention: 'retain-until-explicit-owner-approval'
}

resource staticSite 'Microsoft.Web/staticSites@2024-11-01' = {
  name: staticSiteName
  location: location
  tags: resourceTags
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Disabled'
    enterpriseGradeCdnStatus: 'Disabled'
    publicNetworkAccess: 'Enabled'
    buildProperties: {
      skipGithubActionWorkflowGeneration: true
    }
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: storageAccountName
  location: location
  tags: resourceTags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    allowCrossTenantReplication: false
    allowBlobPublicAccess: true
    publicNetworkAccess: 'Enabled'
  }
}

var familyTestSiteOrigin = 'https://${staticSite.properties.defaultHostname}'

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' = {
  parent: storage
  name: 'default'
  properties: {
    cors: {
      corsRules: [
        {
          allowedOrigins: includeTestOrigin ? [
            'https://mycafegourmand.com'
            familyTestSiteOrigin
          ] : [
            'https://mycafegourmand.com'
          ]
          allowedMethods: [
            'GET'
            'HEAD'
          ]
          allowedHeaders: []
          exposedHeaders: [
            'Content-Type'
            'Content-Length'
            'ETag'
          ]
          maxAgeInSeconds: 3600
        }
      ]
    }
  }
}

resource mediaContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = {
  parent: blobService
  name: mediaContainerName
  properties: {
    publicAccess: 'Blob'
  }
}

output siteOrigin string = familyTestSiteOrigin
output recipeMediaBaseUrl string = '${storage.properties.primaryEndpoints.blob}${mediaContainer.name}'

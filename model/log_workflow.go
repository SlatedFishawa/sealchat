package model

import "time"

// Derived authorization index; draft_json remains the only writable document.
type LogProjectStyleBindingModel struct {
	ProjectID string `gorm:"primaryKey;size:100"`
	PackageID string `gorm:"size:100;index:idx_log_style_binding,priority:1"`
	Version   string `gorm:"size:40;index:idx_log_style_binding,priority:2"`
}

func (*LogProjectStyleBindingModel) TableName() string { return "log_project_style_bindings" }

type LogStylePackageModel struct {
	StringPKBaseModel
	OwnerID       string `gorm:"size:100;index"`
	Name          string `gorm:"size:200"`
	Builtin       bool   `gorm:"not null;default:false"`
	LatestVersion string `gorm:"size:40"`
}

func (*LogStylePackageModel) TableName() string { return "log_style_packages" }

type LogStyleVersionModel struct {
	PackageID   string `gorm:"primaryKey;size:100"`
	Version     string `gorm:"primaryKey;size:40"`
	PackageJSON string `gorm:"not null"`
	CreatedAt   time.Time
}

func (*LogStyleVersionModel) TableName() string { return "log_style_versions" }

type LogStyleAssetModel struct {
	PackageID string `gorm:"primaryKey;size:100"`
	Version   string `gorm:"primaryKey;size:40"`
	AssetID   string `gorm:"primaryKey;size:100"`
	Path      string `gorm:"size:300"`
	MIME      string `gorm:"size:100"`
	Hash      string `gorm:"size:64"`
	Data      []byte
}

func (*LogStyleAssetModel) TableName() string { return "log_style_assets" }

type LogJobModel struct {
	StringPKBaseModel
	Kind        string `gorm:"size:24;index:idx_log_job_claim,priority:1"`
	ActorID     string `gorm:"size:100;uniqueIndex:idx_log_job_op,priority:1"`
	ClientOpID  string `gorm:"size:100;uniqueIndex:idx_log_job_op,priority:2"`
	ProjectID   string `gorm:"size:100;index"`
	ChannelID   string `gorm:"size:100"`
	PayloadHash string `gorm:"size:64"`
	InputJSON   string
	Status      string    `gorm:"size:16;index:idx_log_job_claim,priority:2"`
	LeaseUntil  time.Time `gorm:"default:null;index:idx_log_job_claim,priority:3"`
	LeaseToken  string    `gorm:"size:100"`
	Progress    int64
	Total       int64
	Cursor      int64
	ReleaseID   string `gorm:"size:100"`
	ErrorCode   string `gorm:"size:40"`
}

func (*LogJobModel) TableName() string { return "log_jobs" }

type LogReleaseModel struct {
	StringPKBaseModel
	AssetBytes         int64
	AssetCount         int64
	ProjectID          string `gorm:"size:100;index:idx_log_release_project,priority:1"`
	DraftVersion       int64
	Status             string `gorm:"size:20"`
	DraftJSON          string
	PublicJSON         string
	SourceVersionsJSON string
}

func (*LogReleaseModel) TableName() string { return "log_releases" }

type LogReleaseNodeModel struct {
	ID             string `gorm:"primaryKey;size:100"`
	ReleaseID      string `gorm:"size:100;index:idx_log_node_page,priority:1"`
	SectionID      string `gorm:"size:100;index:idx_log_node_page,priority:2"`
	Ordinal        int64  `gorm:"index:idx_log_node_page,priority:3"`
	MessageID      string `gorm:"size:100;index:idx_log_node_source"`
	ChannelID      string `gorm:"size:100"`
	SourceVersion  int64
	NodeJSON       string
	SearchText     string
	QuoteMessageID string `gorm:"size:100"`
}

func (*LogReleaseNodeModel) TableName() string { return "log_release_nodes" }

type LogReleaseAssetModel struct {
	ReleaseID    string `gorm:"primaryKey;size:100"`
	AssetKey     string `gorm:"primaryKey;size:100"`
	AttachmentID string `gorm:"size:100;index"`
	MIME         string `gorm:"size:100"`
	Hash         string `gorm:"size:64"`
	Data         []byte
}

func (*LogReleaseAssetModel) TableName() string { return "log_release_assets" }

type LogAssetReferenceModel struct {
	ReleaseID string `gorm:"primaryKey;size:100"`
	AssetKey  string `gorm:"primaryKey;size:100"`
	NodeID    string `gorm:"primaryKey;size:100"` // empty means publisher-approved page/style resource
}

func (*LogAssetReferenceModel) TableName() string { return "log_asset_references" }

type MessageMutationPreviewModel struct {
	StringPKBaseModel
	ActorID   string `gorm:"size:100;index"`
	ChannelID string `gorm:"size:100"`
	PatchJSON string
	ExpiresAt time.Time `gorm:"index"`
	Matched   int64
	Allowed   int64
	Ready     bool `gorm:"not null;default:false"`
}

func (*MessageMutationPreviewModel) TableName() string { return "message_mutation_previews" }

type MessageMutationItemModel struct {
	PreviewID string `gorm:"primaryKey;size:100"`
	Ordinal   int64  `gorm:"primaryKey"`
	MessageID string `gorm:"size:100"`
	Version   int64
	Allowed   bool
}

func (*MessageMutationItemModel) TableName() string { return "message_mutation_preview_items" }

type MessageMutationResultModel struct {
	JobID     string `gorm:"primaryKey;size:100"`
	Ordinal   int64  `gorm:"primaryKey"`
	MessageID string `gorm:"size:100"`
	Status    string `gorm:"size:16"`
	Code      string `gorm:"size:40"`
}

func (*MessageMutationResultModel) TableName() string { return "message_mutation_job_items" }

type MessageOperationModel struct {
	ActorID     string `gorm:"primaryKey;size:100"`
	ClientOpID  string `gorm:"primaryKey;size:100"`
	PayloadHash string `gorm:"size:64"`
	ResultJSON  string
	CreatedAt   time.Time
}

func (*MessageOperationModel) TableName() string { return "message_operations" }
